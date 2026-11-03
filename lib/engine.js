/**
 * MyBread calculation engine.
 * Pure functions shared by the build pipeline and CI validation.
 * The native app ports this file to Swift; keep both in sync.
 *
 * All functions operate on *source-format* recipes (see schema/recipe.schema.json):
 * entries reference catalog ingredients via `ingredient` (slug) or `custom_name`,
 * liquids are canonicalized to `ml`, other ingredients to `g`.
 *
 * @module lib/engine
 */

export const MASS_TO_G = {
  g: 1,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
};

export const VOLUME_TO_ML = {
  ml: 1,
  l: 1000,
  tsp: 5,
  tbsp: 15,
  cup: 240,
  fl_oz: 29.5735295625,
};

export const COUNT_TO_G = {
  piece: 50,
  pinch: 0.36,
  handful: 30,
};

const FLOUR_HYDRATION_FALLBACK = 0.65;
const ZONE_TOLERANCE_PCT = 8;

const TRANSLITERATIONS = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
  æ: 'ae',
  ø: 'o',
  å: 'a',
  ç: 'c',
  é: 'e',
  è: 'e',
  ê: 'e',
  à: 'a',
  á: 'a',
  â: 'a',
  ã: 'a',
  í: 'i',
  ì: 'i',
  î: 'i',
  ó: 'o',
  ò: 'o',
  ô: 'o',
  õ: 'o',
  ú: 'u',
  ù: 'u',
  û: 'u',
  ñ: 'n',
};

/**
 * Converts arbitrary text into a URL/filename-safe slug.
 * Handles German umlauts (ä→ae, ö→oe, ü→ue, ß→ss) and strips other diacritics.
 * @param {string} text
 * @returns {string} Lowercase slug matching ^[a-z0-9]+(-[a-z0-9]+)*$ (may be empty for exotic input)
 */
export function slugify(text) {
  let s = String(text ?? '').toLowerCase();
  s = s.replace(/[äöüßæøåçéèêàáâãíìîóòôõúùûñ]/g, (ch) => TRANSLITERATIONS[ch] ?? ch);
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s;
}

/**
 * Converts an amount with a unit to grams (volumes use 1 g/ml default density).
 * @param {number} amount
 * @param {string} unit
 * @returns {number}
 */
export function toGrams(amount, unit) {
  const a = Number(amount ?? 0);
  if (MASS_TO_G[unit]) return round(a * MASS_TO_G[unit], 3);
  if (VOLUME_TO_ML[unit]) return round(a * VOLUME_TO_ML[unit], 3);
  if (COUNT_TO_G[unit]) return round(a * COUNT_TO_G[unit], 3);
  return round(a, 3);
}

/**
 * Converts an amount with a unit to milliliters (masses use 1 g/ml default density).
 * @param {number} amount
 * @param {string} unit
 * @returns {number}
 */
export function toMilliliters(amount, unit) {
  const a = Number(amount ?? 0);
  if (VOLUME_TO_ML[unit]) return round(a * VOLUME_TO_ML[unit], 3);
  if (MASS_TO_G[unit]) return round(a * MASS_TO_G[unit], 3);
  return round(a, 3);
}

/**
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
export function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Canonicalizes a source-format recipe's amounts to SI units:
 * flours in g (`amount_g`), liquids in ml, other ingredients in g.
 * Non-finite/negative entries are dropped, mirroring the legacy server behavior.
 * @param {object} recipe - Source-format recipe
 * @returns {object} Recipe copy with canonicalized flours/liquids/other_ingredients
 */
export function canonicalizeRecipe(recipe) {
  const out = { ...recipe };

  out.flours = (recipe.flours || [])
    .map((item) => ({ ...item, amount_g: round(Number(item.amount_g ?? 0), 3) }))
    .filter((item) => Number.isFinite(item.amount_g) && item.amount_g >= 0);

  out.liquids = (recipe.liquids || [])
    .map((item) => ({
      ...item,
      amount: toMilliliters(item.amount ?? item.amount_g ?? 0, item.unit ?? 'ml'),
      unit: 'ml',
    }))
    .filter((item) => Number.isFinite(item.amount) && item.amount >= 0);

  out.other_ingredients = (recipe.other_ingredients || recipe.otherIngredients || [])
    .map((item) => ({
      ...item,
      amount: toGrams(item.amount ?? item.amount_g ?? 0, item.unit ?? 'g'),
      unit: 'g',
    }))
    .filter((item) => Number.isFinite(item.amount) && item.amount >= 0);

  return out;
}

/**
 * Resolves an ingredient entry to its catalog object.
 * @param {object} entry - Recipe entry with `ingredient` slug or `custom_name`
 * @param {object} ingredients - Map of slug → ingredient object
 * @returns {object|null} Catalog ingredient or null for custom/unknown entries
 */
function resolveIngredient(entry, ingredients) {
  if (!entry?.ingredient) return null;
  return ingredients[entry.ingredient] ?? null;
}

/**
 * Returns the display name for an ingredient entry.
 * @param {object} entry
 * @param {object} ingredients
 * @returns {string}
 */
function entryName(entry, ingredients) {
  const ing = resolveIngredient(entry, ingredients);
  return ing?.name || entry?.custom_name || '';
}

/**
 * Calculates the hydration percentage of a recipe.
 * Ported from MyBread server/services/hydration.service.js.
 *
 * @param {object} recipe - Canonicalized source-format recipe
 * @param {object} ingredients - Map of slug → ingredient object
 * @returns {{
 *   totalFlour_g: number,
 *   effectiveWater_g: number,
 *   hydration_pct: number,
 *   target_hydration_pct: number,
 *   zone: 'dry'|'normal'|'wet'
 * }}
 */
export function calculateHydration(recipe, ingredients) {
  const flours = recipe.flours || [];
  const liquids = recipe.liquids || [];
  const others = recipe.other_ingredients || [];

  const totalFlour = flours.reduce((sum, f) => sum + (f.amount_g ?? 0), 0);

  const waterFromLiquids = liquids.reduce((sum, l) => {
    const factor = resolveIngredient(l, ingredients)?.hydration_factor ?? 1.0;
    return sum + (l.amount ?? 0) * factor;
  }, 0);

  const waterFromOthers = others.reduce((sum, i) => {
    const factor = resolveIngredient(i, ingredients)?.hydration_factor ?? 0;
    return sum + (i.amount ?? 0) * factor;
  }, 0);

  const effectiveWater = waterFromLiquids + waterFromOthers;
  const hydrationPct = totalFlour > 0 ? (effectiveWater / totalFlour) * 100 : 0;

  const targetHydrationPct =
    totalFlour > 0
      ? (flours.reduce((sum, f) => {
          const factor = resolveIngredient(f, ingredients)?.hydration_factor || FLOUR_HYDRATION_FALLBACK;
          return sum + (f.amount_g ?? 0) * factor;
        }, 0) /
          totalFlour) *
        100
      : 0;

  let zone = 'normal';
  if (totalFlour > 0) {
    const delta = hydrationPct - targetHydrationPct;
    if (delta < -ZONE_TOLERANCE_PCT) zone = 'dry';
    if (delta > ZONE_TOLERANCE_PCT) zone = 'wet';
  }

  return {
    totalFlour_g: round(totalFlour, 1),
    effectiveWater_g: Math.round(effectiveWater),
    hydration_pct: round(hydrationPct, 1),
    target_hydration_pct: round(targetHydrationPct, 1),
    zone,
  };
}

/**
 * Calculates estimated nutritional values for a recipe.
 * Ported from MyBread server/services/hydration.service.js#calculateNutrition.
 *
 * @param {object} recipe - Canonicalized source-format recipe
 * @param {object} ingredients - Map of slug → ingredient object
 * @returns {{ perRecipe: object, per100g: object }}
 */
export function calculateNutrition(recipe, ingredients) {
  let totalWeight = 0;
  let totalCalories = 0;
  let totalProtein = 0;
  let totalSaturatedFat = 0;
  let totalUnsaturatedFat = 0;
  let totalFiber = 0;

  /**
   * @param {object|undefined} nutrition
   * @param {number} weight
   */
  const accumulate = (nutrition, weight) => {
    if (!nutrition) return;
    totalCalories += ((nutrition.calories_kcal || 0) * weight) / 100;
    totalProtein += ((nutrition.protein_g || 0) * weight) / 100;
    totalSaturatedFat += ((nutrition.saturated_fat_g || 0) * weight) / 100;
    totalUnsaturatedFat += ((nutrition.unsaturated_fat_g || 0) * weight) / 100;
    totalFiber += ((nutrition.fiber_g || 0) * weight) / 100;
  };

  for (const flour of recipe.flours || []) {
    const weight = flour.amount_g ?? 0;
    totalWeight += weight;
    accumulate(resolveIngredient(flour, ingredients)?.nutrition_per_100g, weight);
  }

  for (const liquid of recipe.liquids || []) {
    const weight = liquid.amount ?? 0;
    totalWeight += weight;
    accumulate(resolveIngredient(liquid, ingredients)?.nutrition_per_100g, weight);
  }

  for (const ing of recipe.other_ingredients || []) {
    const weight = ing.amount ?? 0;
    totalWeight += weight;
    accumulate(resolveIngredient(ing, ingredients)?.nutrition_per_100g, weight);
  }

  const round1 = (v) => round(v, 1);
  const perRecipe = {
    calories_kcal: Math.round(totalCalories),
    protein_g: round1(totalProtein),
    saturated_fat_g: round1(totalSaturatedFat),
    unsaturated_fat_g: round1(totalUnsaturatedFat),
    fiber_g: round1(totalFiber),
    totalWeight_g: Math.round(totalWeight),
  };

  const factor = totalWeight > 0 ? 100 / totalWeight : 0;
  const per100g = {
    calories_kcal: Math.round(totalCalories * factor),
    protein_g: round1(totalProtein * factor),
    saturated_fat_g: round1(totalSaturatedFat * factor),
    unsaturated_fat_g: round1(totalUnsaturatedFat * factor),
    fiber_g: round1(totalFiber * factor),
  };

  return { perRecipe, per100g };
}

/* ── Rules engine (ported from MyBread server/services/rules.service.js) ── */

const VALID_SEVERITIES = new Set(['error', 'warning', 'info']);
const GLUTEN_LEVELS = { none: 0, low: 1, medium: 2, high: 3 };

/**
 * @param {string} severity
 * @returns {'error'|'warning'|'info'}
 */
function normalizeSeverity(severity) {
  return VALID_SEVERITIES.has(severity) ? severity : 'warning';
}

/**
 * @param {number} value
 * @param {{ min?: number, max?: number }} range
 * @returns {boolean}
 */
function inRange(value, { min, max }) {
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
}

/**
 * @param {object} recipe
 * @param {number} totalFlour
 * @param {string} category
 * @param {object} ingredients
 * @returns {number} Percentage of flour weight belonging to the category
 */
function flourCategoryPct(recipe, totalFlour, category, ingredients) {
  if (totalFlour <= 0) return 0;
  const matchWeight = (recipe.flours || []).reduce((sum, f) => {
    if (resolveIngredient(f, ingredients)?.category === category) return sum + (f.amount_g ?? 0);
    return sum;
  }, 0);
  return (matchWeight / totalFlour) * 100;
}

/**
 * @param {object} recipe
 * @param {number} totalFlour
 * @param {string} property - Substring matched against ingredient/custom names
 * @param {object} ingredients
 * @returns {number}
 */
function flourPropertyPct(recipe, totalFlour, property, ingredients) {
  if (totalFlour <= 0) return 0;
  const term = property.toLowerCase();
  const matchWeight = (recipe.flours || []).reduce((sum, f) => {
    const name = entryName(f, ingredients);
    if (name.toLowerCase().includes(term)) return sum + (f.amount_g ?? 0);
    return sum;
  }, 0);
  return (matchWeight / totalFlour) * 100;
}

/**
 * @param {object} recipe
 * @param {string} category
 * @param {object} ingredients
 * @returns {number} Total grams of other ingredients in the category
 */
function ingredientCategoryWeight(recipe, category, ingredients) {
  return (recipe.other_ingredients || []).reduce((sum, i) => {
    if (resolveIngredient(i, ingredients)?.category === category) return sum + (i.amount ?? 0);
    return sum;
  }, 0);
}

/**
 * @param {object} recipe
 * @param {string} name - Substring matched against ingredient/custom names
 * @param {object} ingredients
 * @returns {number}
 */
function ingredientNameWeight(recipe, name, ingredients) {
  const term = name.toLowerCase();
  return (recipe.other_ingredients || []).reduce((sum, i) => {
    if (entryName(i, ingredients).toLowerCase().includes(term)) return sum + (i.amount ?? 0);
    return sum;
  }, 0);
}

/**
 * @param {object} recipe
 * @param {string} category
 * @param {object} ingredients
 * @returns {number}
 */
function liquidCategoryWeight(recipe, category, ingredients) {
  return (recipe.liquids || []).reduce((sum, l) => {
    if (resolveIngredient(l, ingredients)?.category === category) return sum + (l.amount ?? 0);
    return sum;
  }, 0);
}

/**
 * @param {object} recipe
 * @param {number} totalFlour
 * @param {object} ingredients
 * @returns {number} Weighted average gluten level (0..3)
 */
function avgGluten(recipe, totalFlour, ingredients) {
  if (totalFlour <= 0) return 2;
  let weighted = 0;
  for (const f of recipe.flours || []) {
    const level = GLUTEN_LEVELS[resolveIngredient(f, ingredients)?.gluten] ?? 2;
    weighted += level * (f.amount_g ?? 0);
  }
  return weighted / totalFlour;
}

/**
 * Evaluates a single rule's condition against a recipe.
 * @param {object} rule
 * @param {object} ctx - { recipe, totalFlour, totalIngredients, hydration, ingredients }
 * @returns {boolean}
 */
function evaluateCondition(rule, ctx) {
  const { recipe, totalFlour, totalIngredients, hydration, ingredients } = ctx;
  const cond = rule.condition || {};

  if (cond.flour_category_pct) {
    const pct = flourCategoryPct(recipe, totalFlour, cond.flour_category_pct.category, ingredients);
    if (!inRange(pct, cond.flour_category_pct)) return false;
  }

  if (cond.flour_property_pct) {
    const pct = flourPropertyPct(recipe, totalFlour, cond.flour_property_pct.property, ingredients);
    if (!inRange(pct, cond.flour_property_pct)) return false;
  }

  if (cond.ingredient_category_pct) {
    const weight = ingredientCategoryWeight(recipe, cond.ingredient_category_pct.category, ingredients);
    const pct = totalIngredients > 0 ? (weight / totalIngredients) * 100 : 0;
    if (!inRange(pct, cond.ingredient_category_pct)) return false;
  }

  if (cond.ingredient_category_pct_of_flour) {
    const c = cond.ingredient_category_pct_of_flour;
    const weight = ingredientCategoryWeight(recipe, c.category, ingredients);
    const pct = totalFlour > 0 ? (weight / totalFlour) * 100 : 0;
    const requirePresent = c.requirePresent !== false;
    if (requirePresent && weight <= 0) return false;
    if (!inRange(pct, c)) return false;
  }

  if (cond.ingredient_name_pct) {
    const c = cond.ingredient_name_pct;
    const weight = ingredientNameWeight(recipe, c.name, ingredients);
    const pct = totalFlour > 0 ? (weight / totalFlour) * 100 : 0;
    const requirePresent = c.requirePresent !== false;
    if (requirePresent && weight <= 0) return false;
    if (!inRange(pct, c)) return false;
  }

  if (cond.ingredient_name_pct_of_flour) {
    const c = cond.ingredient_name_pct_of_flour;
    const weight = ingredientNameWeight(recipe, c.name, ingredients);
    const pct = totalFlour > 0 ? (weight / totalFlour) * 100 : 0;
    const requirePresent = c.requirePresent !== false;
    if (requirePresent && weight <= 0) return false;
    if (!inRange(pct, c)) return false;
  }

  if (cond.liquid_category_pct_of_flour) {
    const c = cond.liquid_category_pct_of_flour;
    const weight = liquidCategoryWeight(recipe, c.category, ingredients);
    const pct = totalFlour > 0 ? (weight / totalFlour) * 100 : 0;
    const requirePresent = c.requirePresent !== false;
    if (requirePresent && weight <= 0) return false;
    if (!inRange(pct, c)) return false;
  }

  if (cond.ingredient_category_present) {
    const { category, present } = cond.ingredient_category_present;
    const weight = ingredientCategoryWeight(recipe, category, ingredients);
    if (Boolean(present) !== weight > 0) return false;
  }

  if (cond.ingredient_name_present) {
    const { name, present } = cond.ingredient_name_present;
    const weight = ingredientNameWeight(recipe, name, ingredients);
    if (Boolean(present) !== weight > 0) return false;
  }

  if (cond.flour_gluten_avg) {
    const maxVal = GLUTEN_LEVELS[cond.flour_gluten_avg.max] ?? 1;
    if (avgGluten(recipe, totalFlour, ingredients) > maxVal) return false;
  }

  if (cond.hydration_pct_range) {
    if (totalFlour <= 0) return false;
    if (!inRange(hydration.hydration_pct, cond.hydration_pct_range)) return false;
  }

  if (cond.hydration_zone) {
    const zones = cond.hydration_zone.in || [];
    if (!zones.includes(hydration.zone)) return false;
  }

  // A rule with no recognized conditions never triggers.
  return Object.keys(cond).length > 0;
}

/**
 * Evaluates bread rules against a recipe.
 * Ported from MyBread server/services/rules.service.js#evaluateRules.
 *
 * @param {object} recipe - Canonicalized source-format recipe
 * @param {object} ingredients - Map of slug → ingredient object
 * @param {object[]} rules - Rule definitions (bread-rules.json `rules` array)
 * @param {object} [hydration] - Output of calculateHydration; enables hydration conditions
 * @returns {{
 *   issues: Array<{ ruleId: string, severity: string, message: string,
 *                   suggestions?: string[], adjust_hydration_pct?: number }>,
 *   warnings: string[],
 *   suggestions: string[],
 *   adjustments: object[]
 * }}
 */
export function evaluateRules(recipe, ingredients, rules, hydration = { hydration_pct: 0, zone: 'normal' }) {
  const issues = [];
  const warnings = [];
  const suggestions = [];
  const adjustments = [];

  const totalFlour = (recipe.flours || []).reduce((sum, f) => sum + (f.amount_g ?? 0), 0);
  const totalIngredients = (recipe.other_ingredients || []).reduce((sum, i) => sum + (i.amount ?? 0), 0);

  const ctx = { recipe, totalFlour, totalIngredients, hydration, ingredients };

  for (const rule of rules) {
    if (!evaluateCondition(rule, ctx)) continue;

    const action = rule.action || {};
    const issue = {
      ruleId: rule.id,
      severity: normalizeSeverity(rule.severity),
      message: action.message || '',
    };
    if (action.suggest) issue.suggestions = action.suggest;
    if (action.adjust_hydration_pct !== undefined) {
      issue.adjust_hydration_pct = action.adjust_hydration_pct;
    }
    issues.push(issue);

    if (action.message) warnings.push(action.message);
    if (action.suggest) suggestions.push(...action.suggest);
    if (action.adjust_hydration_pct !== undefined) {
      adjustments.push({
        rule_id: rule.id,
        adjust_hydration_pct: action.adjust_hydration_pct,
        message: action.message,
      });
    }
  }

  return { issues, warnings, suggestions, adjustments };
}
