/**
 * Builds the published `site/` directory from the repository sources:
 *
 *   site/data.json          combined catalog + recipes with resolved ingredient
 *                           objects and precomputed nutrition analysis
 *   site/images/**          recipe images (verbatim) + generated *_thumb.webp,
 *                           hero images (verbatim)
 *
 * The published recipe shape mirrors the legacy MyBread REST API
 * (`ingredientId` inlined, `otherIngredients`, `bakingParams`, ...), so the
 * web client can consume it with minimal changes.
 *
 * Usage: node scripts/build-data.js [--out site]
 *
 * @module scripts/build-data
 */

import { readFile, readdir, writeFile, mkdir, cp, rm } from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { canonicalizeRecipe, calculateNutrition } from '../lib/engine.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const THUMB_MAX_EDGE = 480;
const THUMB_QUALITY = 78;

/**
 * Reads and parses a JSON file relative to the repo root.
 * @param {string} relPath
 * @returns {Promise<any>}
 */
async function readJson(relPath) {
  return JSON.parse(await readFile(path.join(REPO_ROOT, relPath), 'utf-8'));
}

/**
 * Recursively lists files under a directory (relative to repo root).
 * @param {string} relDir
 * @returns {Promise<string[]>} Relative file paths
 */
async function listFiles(relDir) {
  const absDir = path.join(REPO_ROOT, relDir);
  const out = [];
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFiles(rel)));
    } else if (!entry.name.startsWith('.')) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Builds one ingredient entry for a published recipe.
 * @param {object} entry - Source-format entry
 * @param {object} ingredientMap - slug → ingredient
 * @returns {object}
 */
function resolveEntry(entry, ingredientMap) {
  const ing = entry.ingredient ? (ingredientMap[entry.ingredient] ?? null) : null;
  const out = { ingredientId: ing };
  if (!ing && entry.custom_name) out.customName = entry.custom_name;
  return out;
}

/**
 * Converts a canonicalized source recipe into the published (client) shape.
 * @param {object} recipe - Source-format recipe
 * @param {object} ingredientMap - slug → ingredient
 * @param {object} categoryMap - slug → { id, name }
 * @returns {object}
 */
function buildRecipe(recipe, ingredientMap, categoryMap) {
  const canonical = canonicalizeRecipe(recipe);

  const flours = canonical.flours.map((f) => ({
    ...resolveEntry(f, ingredientMap),
    amount_g: f.amount_g,
  }));

  const liquids = canonical.liquids.map((l) => ({
    ...resolveEntry(l, ingredientMap),
    amount: l.amount,
    unit: l.unit || 'ml',
  }));

  const otherIngredients = canonical.other_ingredients.map((o) => ({
    ...resolveEntry(o, ingredientMap),
    ...(o.category ? { category: o.category } : {}),
    amount: o.amount,
    unit: o.unit || 'g',
  }));

  const steps = (recipe.steps || []).map((s) => ({
    order: s.order,
    description: s.description,
    ...(s.duration_min != null ? { duration_min: s.duration_min } : {}),
    ...(s.temperature_c != null ? { temperature_c: s.temperature_c } : {}),
  }));

  const stepSets = (recipe.step_sets || []).map((set) => ({
    categoryId: categoryMap[set.category] ?? { id: set.category, name: set.category },
    steps: (set.steps || []).map((s) => ({
      order: s.order,
      description: s.description,
      ...(s.duration_min != null ? { duration_min: s.duration_min } : {}),
      ...(s.temperature_c != null ? { temperature_c: s.temperature_c } : {}),
    })),
  }));

  const analysis = {
    nutrition: calculateNutrition(canonical, ingredientMap),
  };

  return {
    id: recipe.id,
    title: recipe.title,
    ...(recipe.description != null ? { description: recipe.description } : {}),
    language: recipe.language || 'en-US',
    author: recipe.author,
    tags: recipe.tags || [],
    flours,
    liquids,
    otherIngredients,
    steps,
    stepSets,
    techniques: recipe.techniques || [],
    ...(recipe.fermentation ? { fermentation: recipe.fermentation } : {}),
    ...(recipe.baking_params ? { bakingParams: recipe.baking_params } : {}),
    ...(recipe.total_prep_time_min != null ? { totalPrepTime_min: recipe.total_prep_time_min } : {}),
    images: recipe.images || [],
    ...(recipe.created_at ? { created_at: recipe.created_at } : {}),
    ...(recipe.updated_at ? { updated_at: recipe.updated_at } : {}),
    analysis,
  };
}

/**
 * Generates a thumbnail for an image into the site directory.
 * @param {string} relSrc - Source path relative to repo root
 * @param {string} siteDir
 * @returns {Promise<void>}
 */
async function generateThumbnail(relSrc, siteDir) {
  const parsed = path.parse(relSrc);
  const thumbRel = path.join(parsed.dir, `${parsed.name}_thumb.webp`);
  const absSrc = path.join(REPO_ROOT, relSrc);
  const absOut = path.join(siteDir, thumbRel);
  await mkdir(path.dirname(absOut), { recursive: true });
  const meta = await sharp(absSrc).metadata();
  const longestEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (longestEdge > THUMB_MAX_EDGE) {
    await sharp(absSrc)
      .resize({ width: THUMB_MAX_EDGE, height: THUMB_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: THUMB_QUALITY })
      .toFile(absOut);
  } else {
    await sharp(absSrc).webp({ quality: THUMB_QUALITY }).toFile(absOut);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const siteDir = path.resolve(outIdx >= 0 ? args[outIdx + 1] : path.join(REPO_ROOT, 'site'));

  /* ── Load sources ─────────────────────────────────────────────── */
  const [flours, liquids, baking, stepCategories, heroImages, rulesDoc] = await Promise.all([
    readJson('data/ingredients/flours.json'),
    readJson('data/ingredients/liquids.json'),
    readJson('data/ingredients/baking.json'),
    readJson('data/meta/step-categories.json'),
    readJson('data/meta/hero-images.json'),
    readJson('rules/bread-rules.json'),
  ]);

  const ingredientMap = {};
  for (const ing of [...flours, ...liquids, ...baking]) {
    ingredientMap[ing.id] = ing;
  }
  const categoryMap = {};
  for (const cat of stepCategories) {
    categoryMap[cat.id] = cat;
  }

  const recipeFiles = (await listFiles('data/recipes')).filter((f) => f.endsWith('.json')).sort();
  const recipes = [];
  const tags = new Set();
  for (const file of recipeFiles) {
    const recipe = await readJson(file);
    recipes.push(buildRecipe(recipe, ingredientMap, categoryMap));
    for (const tag of recipe.tags || []) tags.add(tag);
  }

  const data = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    repo: 'Delors/mybread-data',
    ingredients: { flours, liquids, baking },
    step_categories: stepCategories,
    tags: [...tags].sort(),
    hero_images: heroImages,
    rules: rulesDoc,
    recipes,
  };

  /* ── Write site/ ──────────────────────────────────────────────── */
  await rm(siteDir, { recursive: true, force: true });
  await mkdir(siteDir, { recursive: true });
  await writeFile(path.join(siteDir, 'data.json'), `${JSON.stringify(data)}\n`, 'utf-8');

  const imageFiles = await listFiles('images');
  let thumbs = 0;
  for (const rel of imageFiles) {
    const absOut = path.join(siteDir, rel);
    await mkdir(path.dirname(absOut), { recursive: true });
    await cp(path.join(REPO_ROOT, rel), absOut);
    if (rel.startsWith(`images${path.sep}recipes`) && rel.endsWith('.webp') && !rel.includes('_thumb')) {
      await generateThumbnail(rel, siteDir);
      thumbs += 1;
    }
  }

  const sizeKb = (Buffer.byteLength(JSON.stringify(data)) / 1024).toFixed(1);
  console.log(
    `built ${path.relative(REPO_ROOT, siteDir) || siteDir}: data.json (${sizeKb} KB), ` +
      `${recipes.length} recipes, ${imageFiles.length} images, ${thumbs} thumbnails`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
