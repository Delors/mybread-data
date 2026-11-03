/**
 * Validates the repository data. Used by CI on every pull request and push.
 *
 * Checks:
 *  - JSON Schema conformance for recipes, ingredient catalogs, and meta files
 *  - recipe id matches file name; ids unique across recipes and ingredients
 *  - ingredient / step-category references resolve
 *  - every ingredient entry has either `ingredient` or `custom_name`
 *  - referenced images exist, are WebP, within size/dimension limits
 *  - hydration sanity and error-severity rule violations (rules engine)
 *
 * Usage: node scripts/validate.js
 *
 * @module scripts/validate
 */

import { readFile, readdir, stat } from 'fs/promises';
import path from 'path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import sharp from 'sharp';
import { canonicalizeRecipe, calculateHydration, evaluateRules } from '../lib/engine.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const MAX_IMAGE_BYTES = 600 * 1024;
const MAX_IMAGE_EDGE = 2000;
const HYDRATION_MIN = 20;
const HYDRATION_MAX = 150;

/** @type {{ errors: string[], warnings: string[] }} */
const report = { errors: [], warnings: [] };

/**
 * @param {string} relPath
 * @returns {Promise<any>}
 */
async function readJson(relPath) {
  return JSON.parse(await readFile(path.join(REPO_ROOT, relPath), 'utf-8'));
}

/**
 * @param {string} relDir
 * @returns {Promise<string[]>} File names in a directory (empty if missing)
 */
async function listDir(relDir) {
  try {
    const entries = await readdir(path.join(REPO_ROOT, relDir));
    return entries.filter((e) => e.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

/**
 * Reports an Ajv validation result.
 * @param {string} relPath
 * @param {boolean} valid
 * @param {object[]} [errors]
 */
function reportAjv(relPath, valid, errors) {
  if (valid) return;
  for (const err of errors || []) {
    report.errors.push(`${relPath}: ${err.instancePath || '/'} ${err.message}`);
  }
}

async function main() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  const recipeSchema = await readJson('schema/recipe.schema.json');
  const ingredientSchema = await readJson('schema/ingredient.schema.json');
  const metaSchema = await readJson('schema/meta.schema.json');

  const validateRecipe = ajv.compile(recipeSchema);
  const validateIngredients = ajv.compile(ingredientSchema);
  const validateStepCategories = ajv.compile(metaSchema.$defs.stepCategories);
  const validateHeroImages = ajv.compile(metaSchema.$defs.heroImages);

  /* ── Ingredients ──────────────────────────────────────────────── */
  const ingredientIds = new Set();
  const ingredientMap = {};
  const ingredientFiles = {
    'data/ingredients/flours.json': 'flour',
    'data/ingredients/liquids.json': 'liquid',
    'data/ingredients/baking.json': 'baking_ingredient',
  };

  for (const [file] of Object.entries(ingredientFiles)) {
    let entries;
    try {
      entries = await readJson(file);
    } catch (err) {
      report.errors.push(`${file}: cannot read (${err.message})`);
      continue;
    }
    reportAjv(file, validateIngredients(entries), validateIngredients.errors);

    const namesSeen = new Map();
    for (const ing of entries) {
      if (!ing?.id) continue;
      if (ingredientIds.has(ing.id)) {
        report.errors.push(`${file}: duplicate ingredient id '${ing.id}'`);
      }
      ingredientIds.add(ing.id);
      ingredientMap[ing.id] = ing;

      const nameKey = String(ing.name || '').toLowerCase();
      if (namesSeen.has(nameKey)) {
        report.warnings.push(`${file}: duplicate ingredient name '${ing.name}' (ids: ${namesSeen.get(nameKey)}, ${ing.id})`);
      }
      namesSeen.set(nameKey, ing.id);
    }
  }

  /* ── Meta ─────────────────────────────────────────────────────── */
  const categoryIds = new Set();
  let stepCategories = [];
  try {
    stepCategories = await readJson('data/meta/step-categories.json');
    reportAjv('data/meta/step-categories.json', validateStepCategories(stepCategories), validateStepCategories.errors);
    for (const cat of stepCategories) {
      if (categoryIds.has(cat.id)) {
        report.errors.push(`data/meta/step-categories.json: duplicate id '${cat.id}'`);
      }
      categoryIds.add(cat.id);
    }
  } catch (err) {
    report.errors.push(`data/meta/step-categories.json: cannot read (${err.message})`);
  }

  let heroImages = [];
  try {
    heroImages = await readJson('data/meta/hero-images.json');
    reportAjv('data/meta/hero-images.json', validateHeroImages(heroImages), validateHeroImages.errors);
  } catch (err) {
    report.errors.push(`data/meta/hero-images.json: cannot read (${err.message})`);
  }
  for (const hero of heroImages) {
    if (hero.url && !/^https?:\/\//.test(hero.url)) {
      try {
        await stat(path.join(REPO_ROOT, hero.url));
      } catch {
        report.errors.push(`data/meta/hero-images.json: hero image not found: ${hero.url}`);
      }
    }
  }

  /* ── Rules (for error-severity checks) ────────────────────────── */
  let rules = [];
  try {
    rules = (await readJson('rules/bread-rules.json')).rules || [];
  } catch (err) {
    report.warnings.push(`rules/bread-rules.json: cannot read (${err.message})`);
  }

  /* ── Recipes ──────────────────────────────────────────────────── */
  const recipeIds = new Set();
  const recipeFiles = await listDir('data/recipes');
  if (recipeFiles.length === 0) {
    report.warnings.push('data/recipes/: no recipe files found');
  }

  for (const fileName of recipeFiles) {
    const relPath = `data/recipes/${fileName}`;
    let recipe;
    try {
      recipe = await readJson(relPath);
    } catch (err) {
      report.errors.push(`${relPath}: cannot read (${err.message})`);
      continue;
    }

    reportAjv(relPath, validateRecipe(recipe), validateRecipe.errors);
    if (!recipe?.id) continue;

    if (path.basename(fileName, '.json') !== recipe.id) {
      report.errors.push(`${relPath}: id '${recipe.id}' does not match file name`);
    }
    if (recipeIds.has(recipe.id)) {
      report.errors.push(`${relPath}: duplicate recipe id '${recipe.id}'`);
    }
    recipeIds.add(recipe.id);

    /* Ingredient references */
    const allEntries = [
      ...(recipe.flours || []).map((e) => ({ e, kind: 'flours' })),
      ...(recipe.liquids || []).map((e) => ({ e, kind: 'liquids' })),
      ...(recipe.other_ingredients || []).map((e) => ({ e, kind: 'other_ingredients' })),
    ];
    for (const { e, kind } of allEntries) {
      if (e.ingredient && !ingredientIds.has(e.ingredient)) {
        report.errors.push(`${relPath}: ${kind} references unknown ingredient '${e.ingredient}'`);
      }
      if (!e.ingredient && !e.custom_name) {
        report.errors.push(`${relPath}: ${kind} entry has neither 'ingredient' nor 'custom_name'`);
      }
      if (e.ingredient && e.custom_name) {
        report.warnings.push(`${relPath}: ${kind} entry has both 'ingredient' and 'custom_name'`);
      }
    }

    /* Step-set category references */
    for (const set of recipe.step_sets || []) {
      if (!categoryIds.has(set.category)) {
        report.errors.push(`${relPath}: step_sets references unknown category '${set.category}'`);
      }
    }

    /* Step ordering */
    for (const [listName, list] of [
      ['steps', recipe.steps],
      ...(recipe.step_sets || []).map((s, i) => [`step_sets[${i}].steps`, s.steps]),
    ]) {
      if (!list) continue;
      const orders = list.map((s) => s.order);
      if (new Set(orders).size !== orders.length) {
        report.warnings.push(`${relPath}: ${listName} contains duplicate 'order' values`);
      }
    }

    /* Images */
    for (const img of recipe.images || []) {
      const absImg = path.join(REPO_ROOT, img);
      let stats;
      try {
        stats = await stat(absImg);
      } catch {
        report.errors.push(`${relPath}: image not found: ${img}`);
        continue;
      }
      if (stats.size > MAX_IMAGE_BYTES) {
        report.errors.push(
          `${relPath}: image too large: ${img} (${Math.round(stats.size / 1024)} KB > ${MAX_IMAGE_BYTES / 1024} KB)`,
        );
      }
      const meta = await sharp(absImg).metadata();
      if (meta.format !== 'webp') {
        report.errors.push(`${relPath}: image is not WebP: ${img} (${meta.format})`);
      }
      if (Math.max(meta.width ?? 0, meta.height ?? 0) > MAX_IMAGE_EDGE) {
        report.errors.push(
          `${relPath}: image too big: ${img} (${meta.width}x${meta.height}, longest edge must be ≤ ${MAX_IMAGE_EDGE}px)`,
        );
      }
      if (!img.startsWith(`images/recipes/${recipe.id}/`)) {
        report.warnings.push(`${relPath}: image path should live under images/recipes/${recipe.id}/: ${img}`);
      }
    }

    /* Canonicalization hint (not an error: the build canonicalizes anyway) */
    for (const l of recipe.liquids || []) {
      if (l.unit && l.unit !== 'ml') {
        report.warnings.push(`${relPath}: liquid uses unit '${l.unit}'; prefer canonical 'ml'`);
      }
    }
    for (const o of recipe.other_ingredients || []) {
      if (o.unit && o.unit !== 'g') {
        report.warnings.push(`${relPath}: other ingredient uses unit '${o.unit}'; prefer canonical 'g'`);
      }
    }

    /* Engine sanity: hydration + error-severity rules */
    const canonical = canonicalizeRecipe(recipe);
    const hydration = calculateHydration(canonical, ingredientMap);
    if (hydration.hydration_pct < HYDRATION_MIN || hydration.hydration_pct > HYDRATION_MAX) {
      report.errors.push(
        `${relPath}: hydration ${hydration.hydration_pct}% outside sanity range [${HYDRATION_MIN}, ${HYDRATION_MAX}]`,
      );
    }
    const ruleResult = evaluateRules(canonical, ingredientMap, rules, hydration);
    for (const issue of ruleResult.issues) {
      if (issue.severity === 'error') {
        report.errors.push(`${relPath}: [${issue.ruleId}] ${issue.message}`);
      } else {
        report.warnings.push(`${relPath}: [${issue.ruleId}] ${issue.message}`);
      }
    }
  }

  /* ── Report ───────────────────────────────────────────────────── */
  console.log(`validated ${recipeFiles.length} recipes, ${ingredientIds.size} ingredients, ${heroImages.length} hero images`);
  if (report.warnings.length > 0) {
    console.log(`\nwarnings (${report.warnings.length}):`);
    for (const w of report.warnings) console.log(`  ⚠ ${w}`);
  }
  if (report.errors.length > 0) {
    console.log(`\nerrors (${report.errors.length}):`);
    for (const e of report.errors) console.log(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log('all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
