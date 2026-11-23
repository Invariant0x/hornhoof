/* The map recipes Hornhoof ships, by id. A recipe is code that shapes the ground, so a world written as data (a theme
   archive's world/world.json) names one of these instead of bringing its own; a new map shape is a new recipe here. */

import type { TerrainRecipeSpec } from '../world/manifest';
import { DUNGEON_TERRAIN_RECIPE } from './dungeon/recipe';
import { EGYPT_TERRAIN_RECIPE } from './egypt/recipe';
import { SPACE_TERRAIN_RECIPE } from './space/recipe';

const RECIPES: readonly TerrainRecipeSpec[] = [EGYPT_TERRAIN_RECIPE, SPACE_TERRAIN_RECIPE, DUNGEON_TERRAIN_RECIPE];

export const shippedRecipe = (id: string): TerrainRecipeSpec | null => RECIPES.find(recipe => recipe.id === id) ?? null;
export const shippedRecipeIds = (): readonly string[] => RECIPES.map(recipe => recipe.id);
