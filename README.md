# MyBread Data

The recipe database for [MyBread](https://www.michael-eichberg.de/mybread) — a free bread-baking
recipe catalog. This repository is the single source of truth; there is no classical database
server. The website and the MyBread app are read-only consumers of what is published here.

## How it works

- **Recipes** live in `data/recipes/` — one JSON file per recipe, named `<id>.json`.
- **Ingredients** live in `data/ingredients/` (`flours.json`, `liquids.json`, `baking.json`).
- **Meta data** (step categories, hero image URLs) lives in `data/meta/`.
- **Images** live in `images/recipes/<recipe-id>/` and `images/hero/` (WebP only).
- Every merge to `main` triggers a GitHub Action that validates the data, builds a combined
  [`data.json`](https://delors.github.io/mybread-data/data.json) (recipes with resolved
  ingredients + precomputed nutrition), generates thumbnails, and publishes everything
  via GitHub Pages at <https://delors.github.io/mybread-data/>.

The MyBread app (macOS/iOS) creates recipes and edit proposals as **pull requests** to this
repository. Reviewing and merging a PR is what "publishes" a recipe.

## Repository layout

```
data/recipes/<id>.json        one recipe per file (see schema/recipe.schema.json)
data/ingredients/*.json       ingredient catalogs (see schema/ingredient.schema.json)
data/meta/step-categories.json
data/meta/hero-images.json    hero image URLs shown on the website home page
images/recipes/<id>/N.webp    recipe images
images/hero/*.webp            hero images
rules/bread-rules.json        bread-baking rule definitions used by the app
schema/                       JSON Schemas (the data contract)
lib/engine.js                 shared calculation engine (hydration, nutrition, rules)
scripts/validate.js           CI validation
scripts/build-data.js         builds site/ (data.json + images + thumbnails)
scripts/export-from-mongo.js  one-shot migration from the legacy MongoDB app
```

## Contributing

The easiest way is the **MyBread app**, which handles all Git details for you.
Manual contributions via GitHub are equally welcome:

1. Fork or branch, add/edit files under `data/` and `images/`.
2. Open a pull request. CI validates schema, references, images, and baking sanity
   (e.g. missing salt or leavening fail the build).
3. A maintainer reviews and merges — the change goes live within minutes.

### Recipe format (summary)

All amounts are stored in SI units: flours in grams (`amount_g`), liquids in milliliters,
other ingredients in grams. See [`schema/recipe.schema.json`](schema/recipe.schema.json)
for the full contract.

```json
{
  "id": "my-sourdough",
  "title": "My Sourdough",
  "language": "en-US",
  "author": "Jane Baker",
  "tags": ["sourdough"],
  "flours": [{ "ingredient": "wheat-flour-type-550", "amount_g": 500 }],
  "liquids": [{ "ingredient": "water", "amount": 350, "unit": "ml" }],
  "other_ingredients": [{ "ingredient": "salt", "amount": 10, "unit": "g" }],
  "steps": [{ "order": 1, "description": "Mix and autolyse.", "duration_min": 60 }],
  "images": ["images/recipes/my-sourdough/1.webp"]
}
```

- Ingredients are referenced by their catalog `id`; use `"custom_name": "…"` for
  ingredients that are not in the catalog (or add them to the catalog in the same PR).
- `id` must equal the file name, be lowercase-kebab, and unique.

### Image rules

- Format: **WebP** only.
- Longest edge: **≤ 2000 px**, file size **≤ 600 KB**.
- Path: `images/recipes/<recipe-id>/<N>.webp`, numbered from 1.
- Thumbnails are generated automatically at publish time; do not commit them.

## Local development

```sh
npm install
npm run validate   # run all CI checks locally
npm run build      # build site/ (data.json + images + thumbnails)
open site/data.json
```
