/* The ground a city stands on, for the renderer (#1958): which lots are cleared in the baked ground, which tiles plants
   leave, and a short key that changes whenever either does, so both are rebuilt only then. Contains no theme words. */

import { cityPlantCover } from './city-layout';
import type { CityRenderState } from './city-renderer';
import { cityLotClearing, surveyedLot, type LotClearing, type LotRect } from './lot-clearing';
import type { WorldPackManifest } from './manifest';

type GroundState = Pick<CityRenderState, 'city' | 'worldMode' | 'emptyLotStakes'>;

export type CityGround = Readonly<{
  clearing: LotClearing | null;
  /* Whether plants stay off a tile; null when the map has no city. */
  cover: ((col: number, row: number) => boolean) | null;
}>;

/* The surveyed plot of a new company's empty lot, where its stakes stand; null in any other mode. */
function surveyOf(state: GroundState): LotRect | null {
  return state.worldMode === 'empty_lot' ? surveyedLot(state.emptyLotStakes ?? []) : null;
}

function hashLots<T extends LotRect>(sum: number, lots: readonly T[], mark: (lot: T) => number): number {
  let s = sum;
  for (const l of lots) s = (s * 31 + l.col * 7 + l.row * 13 + l.spanCol * 3 + l.spanRow + mark(l)) % 1_000_000_007;
  return s;
}

/* A short text that changes whenever the cleared lots or the city's streets and walls do. */
export function cityGroundKey(state: GroundState | null): string {
  if (!state) return 'none';
  const city = state.city;
  const survey = surveyOf(state);
  const buildings = hashLots(0, city.buildings, b => (b.stage >= 1 ? 17 : 0));
  const sum = hashLots(buildings, [...city.vacatedLots, ...(survey ? [survey] : [])], () => 5);
  return `${city.buildings.length}|${city.vacatedLots.length}|${city.roads.size}|${city.wallTiles.size}|${sum}`;
}

function withLot(cover: (col: number, row: number) => boolean, lot: LotRect): (col: number, row: number) => boolean {
  return (col, row) => cover(col, row) || (col >= lot.col && col <= lot.col + lot.spanCol && row >= lot.row && row <= lot.row + lot.spanRow);
}

/* The city's cleared lots under the pack's rule and the tiles plants leave: its buildings, streets and walls, and on an
   empty lot the surveyed plot with its stakes and rope. */
export function cityGround(state: GroundState | null, pack: WorldPackManifest): CityGround {
  if (!state) return { clearing: null, cover: null };
  const survey = surveyOf(state);
  const cover = cityPlantCover(state.city);
  if (!survey) return { clearing: cityLotClearing(state.city, pack), cover };
  return { clearing: cityLotClearing(state.city, pack, [survey]), cover: withLot(cover, survey) };
}
