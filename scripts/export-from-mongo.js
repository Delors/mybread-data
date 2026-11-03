/**
 * One-shot migration: exports the legacy MyBread MongoDB database into this
 * repository's file layout.
 *
 * Usage:
 *   node --env-file=/path/to/MyBread/.env scripts/export-from-mongo.js --source /path/to/MyBread
 *
 * Reads: recipes, ingredients, stepcategories, users collections plus
 * <source>/uploads/recipes/* (recipe images) and <source>/images/* (hero images).
 * Writes: data/**, images/**, rules/bread-rules.json (relative to repo root).
 *
 * @module scripts/export-from-mongo
 */

import { readFile, writeFile, mkdir, copyFile, access } from 'fs/promises';
import path from 'path';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { slugify, canonicalizeRecipe } from '../lib/engine.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Parses simple --key value CLI arguments.
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

/**
 * Strips HTML tags from a string (for plain-text copyright).
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Creates a slug registry that resolves collisions with numeric suffixes.
 * @returns {{ make: (text: string) => string }}
 */
function createSlugRegistry() {
  const used = new Set();
  return {
    /**
     * @param {string} text
     * @returns {string} Unique slug
     */
    make(text) {
      const base = slugify(text) || 'item';
      let slug = base;
      let n = 2;
      while (used.has(slug)) {
        slug = `${base}-${n}`;
        n += 1;
      }
      used.add(slug);
      return slug;
    },
  };
}

/**
 * Removes undefined/null values and empty arrays/objects recursively,
 * so exported JSON files stay compact and readable.
 * @param {any} value
 * @returns {any}
 */
function prune(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map(prune).filter((v) => v !== undefined && v !== null);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const pv = prune(v);
      if (pv === undefined || pv === null) continue;
      if (Array.isArray(pv) && pv.length === 0) continue;
      if (typeof pv === 'object' && !Array.isArray(pv) && Object.keys(pv).length === 0) continue;
      out[k] = pv;
    }
    return Object.keys(out).length > 0 || !Array.isArray(value) ? out : undefined;
  }
  return value;
}

/**
 * Writes a JSON file (creating parent directories) with stable formatting.
 * @param {string} relPath - Path relative to repo root
 * @param {any} data
 */
async function writeJson(relPath, data) {
  const full = path.join(REPO_ROOT, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  console.log(`wrote ${relPath}`);
}

/**
 * Converts an image to WebP within a size budget.
 * @param {string} inputPath
 * @param {string} relOutputPath - Output path relative to repo root
 * @param {{ maxEdge?: number, quality?: number }} [options]
 * @returns {Promise<boolean>} True on success, false if the source is missing
 */
async function convertImage(inputPath, relOutputPath, { maxEdge = 1600, quality = 82 } = {}) {
  try {
    await access(inputPath);
  } catch {
    console.warn(`  ! missing image: ${inputPath}`);
    return false;
  }
  const full = path.join(REPO_ROOT, relOutputPath);
  await mkdir(path.dirname(full), { recursive: true });
  await sharp(inputPath)
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toFile(full);
  return true;
}

/**
 * Maps a legacy Mongo ingredient document to its exported shape.
 * @param {object} doc
 * @param {string} id - Assigned slug
 * @returns {object}
 */
function exportIngredient(doc, id) {
  return prune({
    id,
    name: doc.name,
    category: doc.category,
    gluten: doc.gluten,
    hydration: doc.hydration,
    hydration_factor: doc.hydration_factor,
    sourdough: doc.sourdough,
    acidity: doc.acidity,
    fat_content: doc.fat_content,
    typical_usage_pct: doc.typical_usage_pct,
    function: doc.function,
    impact: doc.impact,
    nutrition_per_100g: doc.nutrition_per_100g,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRepo = path.resolve(args.source || process.env.SOURCE_REPO || '../MyBread');
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI is not set. Run with: node --env-file=/path/to/MyBread/.env ...');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db;
  console.log(`connected; source repo: ${sourceRepo}`);

  const [users, ingredientDocs, categoryDocs, recipeDocs] = await Promise.all([
    db.collection('users').find({}).toArray(),
    db.collection('ingredients').find({}).sort({ _id: 1 }).toArray(),
    db.collection('stepcategories').find({}).sort({ _id: 1 }).toArray(),
    db.collection('recipes').find({}).sort({ createdAt: 1 }).toArray(),
  ]);

  /* ── Users → author names ─────────────────────────────────────── */
  const userNames = new Map(users.map((u) => [String(u._id), u.username || 'Unknown']));

  /* ── Ingredients ──────────────────────────────────────────────── */
  const referencedIds = new Set();
  for (const r of recipeDocs) {
    for (const list of [r.flours, r.liquids, r.otherIngredients]) {
      for (const entry of list || []) {
        if (entry.ingredientId) referencedIds.add(String(entry.ingredientId));
      }
    }
  }

  const slugs = createSlugRegistry();
  const ingredientSlugs = new Map(); // ObjectId string → slug
  const byType = { flour: [], liquid: [], baking_ingredient: [] };
  let skippedPending = 0;

  for (const doc of ingredientDocs) {
    const idStr = String(doc._id);
    if (doc.status === 'pending' && !referencedIds.has(idStr)) {
      skippedPending += 1;
      continue;
    }
    if (doc.status === 'pending') {
      console.warn(`  ! exporting pending ingredient referenced by a recipe: ${doc.name}`);
    }
    const slug = slugs.make(doc.name);
    ingredientSlugs.set(idStr, slug);
    byType[doc.type]?.push(exportIngredient(doc, slug));
  }

  await writeJson('data/ingredients/flours.json', byType.flour);
  await writeJson('data/ingredients/liquids.json', byType.liquid);
  await writeJson('data/ingredients/baking.json', byType.baking_ingredient);
  console.log(
    `ingredients: ${byType.flour.length} flours, ${byType.liquid.length} liquids, ` +
      `${byType.baking_ingredient.length} baking (${skippedPending} unreferenced pending skipped)`,
  );

  /* ── Step categories ──────────────────────────────────────────── */
  const categorySlugs = new Map();
  const categories = [];
  for (const doc of categoryDocs) {
    if (doc.status && doc.status !== 'approved') continue;
    const slug = slugs.make(doc.name);
    categorySlugs.set(String(doc._id), slug);
    categories.push({ id: slug, name: doc.name });
  }
  await writeJson('data/meta/step-categories.json', categories);

  /**
   * Resolves the ingredient reference fields for a legacy entry.
   * @param {object} entry
   * @returns {{ ingredient?: string, custom_name?: string }}
   */
  const refFields = (entry) => {
    const slug = entry.ingredientId ? ingredientSlugs.get(String(entry.ingredientId)) : undefined;
    if (entry.ingredientId && !slug) {
      console.warn(`  ! dangling ingredient ref in recipe entry: ${JSON.stringify(entry)}`);
    }
    return slug ? { ingredient: slug } : { custom_name: entry.customName || undefined };
  };

  /* ── Recipes ──────────────────────────────────────────────────── */
  let imageCount = 0;
  for (const doc of recipeDocs) {
    const slug = slugs.make(doc.title);

    const entries = {
      flours: (doc.flours || []).map((entry) =>
        prune({ ...refFields(entry), amount_g: entry.amount_g ?? entry.amount }),
      ),
      liquids: (doc.liquids || []).map((entry) =>
        prune({ ...refFields(entry), amount: entry.amount ?? entry.amount_g, unit: entry.unit || 'ml' }),
      ),
      other_ingredients: (doc.otherIngredients || []).map((entry) =>
        prune({
          ...refFields(entry),
          category: entry.category,
          amount: entry.amount ?? entry.amount_g,
          unit: entry.unit || 'g',
        }),
      ),
    };

    // Canonicalize to SI (liquids → ml, others → g) using the shared engine.
    const canonical = canonicalizeRecipe(entries);

    const images = [];
    for (let i = 0; i < (doc.images || []).length; i += 1) {
      const legacyPath = doc.images[i]; // e.g. /uploads/recipes/xxx.jpeg
      const srcFile = path.join(sourceRepo, legacyPath.replace(/^\//, ''));
      const relOut = `images/recipes/${slug}/${i + 1}.webp`;
      const ok = await convertImage(srcFile, relOut, { maxEdge: 1600, quality: 82 });
      if (ok) {
        images.push(relOut);
        imageCount += 1;
      }
    }

    const recipe = prune({
      id: slug,
      title: doc.title,
      description: doc.description,
      language: doc.sourceLocale || 'en-US',
      author: userNames.get(String(doc.author)) || 'Unknown',
      tags: doc.tags,
      flours: canonical.flours,
      liquids: canonical.liquids,
      other_ingredients: canonical.other_ingredients,
      steps: doc.steps,
      step_sets: (doc.stepSets || []).map((s) => ({
        category: categorySlugs.get(String(s.categoryId)),
        steps: s.steps,
      })),
      techniques: doc.techniques,
      fermentation: doc.fermentation,
      baking_params: doc.bakingParams,
      total_prep_time_min: doc.totalPrepTime_min,
      images,
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
    });

    // prune() drops nulls; ensure step-level optional numbers survive as absent, not null
    await writeJson(`data/recipes/${slug}.json`, recipe);
  }
  console.log(`recipes: ${recipeDocs.length} exported, ${imageCount} images converted`);

  /* ── Hero images ──────────────────────────────────────────────── */
  const heroImages = [];
  try {
    const heroMeta = JSON.parse(await readFile(path.join(sourceRepo, 'images/images.json'), 'utf-8'));
    for (const entry of heroMeta) {
      const srcFile = path.join(sourceRepo, 'images', entry.filename);
      const base = path.parse(entry.filename).name;
      const relOut = `images/hero/${slugify(base) || base}.webp`;
      const ok = await convertImage(srcFile, relOut, { maxEdge: 1920, quality: 78 });
      if (ok) {
        heroImages.push({
          url: relOut,
          copyright: htmlToText(entry.copyright),
          copyright_html: entry.copyright,
        });
      }
    }
  } catch (err) {
    console.warn(`  ! hero images skipped: ${err.message}`);
  }
  await writeJson('data/meta/hero-images.json', heroImages);

  /* ── Rules ────────────────────────────────────────────────────── */
  try {
    await mkdir(path.join(REPO_ROOT, 'rules'), { recursive: true });
    await copyFile(path.join(sourceRepo, 'bread-rules.json'), path.join(REPO_ROOT, 'rules/bread-rules.json'));
    console.log('wrote rules/bread-rules.json');
  } catch (err) {
    console.warn(`  ! bread-rules.json copy failed: ${err.message}`);
  }

  await mongoose.disconnect();
  console.log('export complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
