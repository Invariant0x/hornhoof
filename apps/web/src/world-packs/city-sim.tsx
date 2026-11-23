import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ALL_BUILDING_KINDS,
  type BuildingKind,
  type CityTileBreakdown,
} from '../world/city-layout';
import { renderCitySnapshot } from '../world/city-preview';
import type { WorldPackManifest } from '../world/manifest';
import {
  runFiveYearSimulation,
  SIM_KNOBS,
  SIM_SEEDS,
  type FiveYearSimResult,
} from '../world/simulator';
import { registeredWorldPacks } from './registry';
import { packText } from '../world/pack-text';
import { loadEveryPackTexts } from './pack-text-load';

/* A demo page shows a pack's words in the language its own switch picks, so every language is at hand. */
loadEveryPackTexts();

/* Stage 3 multi-pack 5-year city growth timelapse and 3-seed x 3-knob Order/Chaos comparison viewer.
   Lives outside engine core (src/world-packs/) so engine core stays 100% pack-agnostic. */

type Lang = 'ru' | 'en';
type ViewMode = 'timelapse' | 'matrix';

const AVAILABLE_PACKS: readonly WorldPackManifest[] = registeredWorldPacks();

const COPY: Record<
  Lang,
  {
    title: string;
    subtitle: string;
    packLabel: string;
    modeTimelapse: string;
    modeMatrix: string;
    seedLabel: string;
    knobLabel: string;
    knobNames: Record<string, string>;
    play: string;
    pause: string;
    year: string;
    month: string;
    agents: string;
    tasks: string;
    goals: string;
    statues: string;
    buildings: string;
    wallRing: string;
    densified: string;
    merged: string;
    oldWallRoads: string;
    bridges: string;
    excavated: string;
    straightness: string;
    gridAlign: string;
    areaTitle: string;
    tilesUnit: string;
    roadsLabel: string;
    wallLabel: string;
    lotsLabel: string;
    activeTotal: string;
    enclosedTotal: string;
    kindNames: Record<BuildingKind, string>;
    legend: readonly { color: string; label: string }[];
  }
> = {
  ru: {
    title: 'Этап 3: Рост города за 5 лет (150 агентов, 160 000 задач, 30 главных целей)',
    subtitle: 'Участки 1x1..6x6 по стандарту, рост домов с уровнем, дороги с улучшением, стена и вырубание залов в подземелье.',
    packLabel: 'Пакет мира',
    modeTimelapse: 'Таймлапс 5 лет',
    modeMatrix: 'Сетка 3 зерна x 3 ручки',
    seedLabel: 'Зерно',
    knobLabel: 'Порядок / хаос',
    knobNames: { '0': '0.0 Хаос', '0.5': '0.5 Баланс', '1': '1.0 Порядок' },
    play: 'Старт',
    pause: 'Пауза',
    year: 'Год',
    month: 'Месяц',
    agents: 'Агенты',
    tasks: 'Принятые задачи',
    goals: 'Главные цели',
    statues: 'Статуи отделов',
    buildings: 'Здания на карте',
    wallRing: 'Кольцо стены',
    densified: 'Уплотнение на месте',
    merged: 'Слияния домов',
    oldWallRoads: 'Улицы из старых стен',
    bridges: 'Клетки мостов',
    excavated: 'Вырублено породы',
    straightness: 'Прямизна улиц',
    gridAlign: 'Выравнивание сетки',
    areaTitle: 'Площадь на карте 150 x 150 (22 500 кл.)',
    tilesUnit: 'кл.',
    roadsLabel: 'Дороги и проспекты',
    wallLabel: 'Внешняя стена',
    lotsLabel: 'Свободные участки роста',
    activeTotal: 'Занято городом (здания+участки+дороги+стена)',
    enclosedTotal: 'Внутри внешней стены',
    kindNames: {
      residence: 'Резиденция (2x2..6x6)',
      monument: 'Монументы целей (4x4..6x6)',
      department: 'Отделы (3x3..5x5)',
      district_hub: 'Центры машин (3x3..4x4)',
      supply: 'Склады у воды (3x3)',
      house: 'Дома агентов (1x1..4x4)',
      statue: 'Статуи (1x1..3x3)',
      flophouse: 'Ночлежки (2x2..3x3)',
    },
    legend: [
      { color: '#FFD166', label: 'Резиденция (до 6x6)' },
      { color: '#E09A38', label: 'Монумент цели (4x4..6x6)' },
      { color: '#3B78CC', label: 'Отдел (до 5x5)' },
      { color: '#38C8C8', label: 'Склад у воды/лавы (3x3)' },
      { color: '#D96B52', label: 'Дома (1x1..4x4, цвет района)' },
      { color: '#8C7BA6', label: 'Ночлежка района (2x2..3x3)' },
      { color: '#F7FAFF', label: 'Статуи отдела (1x1..3x3)' },
      { color: '#8A8694', label: 'Вырубленные залы (подземелье)' },
      { color: '#E8EDF5', label: 'Внешняя стена' },
      { color: '#DDE3EB', label: 'Каменная улица / проспект' },
      { color: '#B56B45', label: 'Кирпичная улица' },
      { color: '#7D6342', label: 'Утоптанная земля / тропа' },
    ],
  },
  en: {
    title: 'Stage 3: 5-Year City Growth (150 agents, 160,000 tasks, 30 major goals)',
    subtitle: 'Standard 1x1..6x6 footprints, level-growing houses, traffic-upgraded roads, outer wall and subterranean excavation.',
    packLabel: 'World pack',
    modeTimelapse: '5-Year Timelapse',
    modeMatrix: '3 Seeds x 3 Knobs Grid',
    seedLabel: 'Seed',
    knobLabel: 'Order / Chaos',
    knobNames: { '0': '0.0 Chaos', '0.5': '0.5 Balanced', '1': '1.0 Order' },
    play: 'Play',
    pause: 'Pause',
    year: 'Year',
    month: 'Month',
    agents: 'Agents',
    tasks: 'Accepted tasks',
    goals: 'Major goals',
    statues: 'Dept statues',
    buildings: 'Buildings',
    wallRing: 'Wall ring',
    densified: 'In-place upgrades',
    merged: 'Merged houses',
    oldWallRoads: 'Old-wall streets',
    bridges: 'Bridge tiles',
    excavated: 'Carved bedrock',
    straightness: 'Street straightness',
    gridAlign: 'Grid alignment',
    areaTitle: 'Area on 150 x 150 map (22,500 tiles)',
    tilesUnit: 'tiles',
    roadsLabel: 'Roads & avenues',
    wallLabel: 'Active outer wall',
    lotsLabel: 'Reserved growth yards',
    activeTotal: 'Active footprint (buildings+yards+roads+wall)',
    enclosedTotal: 'Inside outer wall',
    kindNames: {
      residence: 'Residence (2x2..6x6)',
      monument: 'Goal monuments (4x4..6x6)',
      department: 'Departments (3x3..5x5)',
      district_hub: 'Machine hubs (3x3..4x4)',
      supply: 'Liquid-side supply (3x3)',
      house: 'Agent houses (1x1..4x4)',
      statue: 'Statues (1x1..3x3)',
      flophouse: 'District lodges (2x2..3x3)',
    },
    legend: [
      { color: '#FFD166', label: 'Residence (up to 6x6)' },
      { color: '#E09A38', label: 'Goal monument (4x4..6x6)' },
      { color: '#3B78CC', label: 'Department (up to 5x5)' },
      { color: '#38C8C8', label: 'Water/magma supply (3x3)' },
      { color: '#D96B52', label: 'Houses (1x1..4x4, by district)' },
      { color: '#8C7BA6', label: 'District lodge (2x2..3x3)' },
      { color: '#F7FAFF', label: 'Dept statue (1x1..3x3)' },
      { color: '#8A8694', label: 'Carved halls (dungeon)' },
      { color: '#E8EDF5', label: 'Active outer wall' },
      { color: '#DDE3EB', label: 'Stone avenue' },
      { color: '#B56B45', label: 'Brick street' },
      { color: '#7D6342', label: 'Dirt road / trail' },
    ],
  },
};

type CitySimHandle = {
  setPack: (packId: string) => void;
  setMode: (mode: ViewMode) => void;
  setSeed: (seed: string) => void;
  setKnob: (knob: number) => void;
  setMonth: (month: number) => void;
  setLang: (lang: Lang) => void;
  getCurrentSummary: () => {
    packId: string;
    seed: string;
    orderChaos: number;
    month: number;
    agents: number;
    tasks: number;
    goals: number;
    wallGeneration: number;
    buildings: number;
    excavatedTiles: number;
    breakdown: CityTileBreakdown;
  };
};

declare global {
  interface Window {
    __WORLD_CITY_SIM__?: CitySimHandle;
  }
}

function readInitialQuery(): { lang: Lang; mode: ViewMode; packId: string } {
  const params = new URLSearchParams(window.location.search);
  const lang: Lang = params.get('lang') === 'en' ? 'en' : 'ru';
  const mode: ViewMode = params.get('mode') === 'matrix' ? 'matrix' : 'timelapse';
  const rawPack = params.get('pack');
  const packId = AVAILABLE_PACKS.some(p => p.id === rawPack) ? rawPack! : AVAILABLE_PACKS[0]!.id;
  return { lang, mode, packId };
}

function MatrixCard({
  sim,
  pack,
  lang,
}: {
  sim: FiveYearSimResult;
  pack: WorldPackManifest;
  lang: Lang;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const t = COPY[lang];
  const lastFrame = sim.frames[sim.frames.length - 1]!;
  const b = lastFrame.breakdown;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderCitySnapshot(canvas, sim.map, lastFrame.snapshot, pack, 2);
  }, [sim, pack, lastFrame]);

  return (
    <div
      data-testid={`matrix-card-${sim.seed}-${sim.orderChaos}`}
      style={{
        display: 'grid',
        gap: 6,
        padding: 10,
        background: '#19222E',
        border: '1px solid rgba(130, 184, 224, 0.3)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
        <strong style={{ color: '#9BD9FF', fontSize: 13 }}>{sim.seed}</strong>
        <span style={{ color: '#FFE08A', fontSize: 12, fontWeight: 700 }}>
          {t.knobNames[String(sim.orderChaos)] ?? String(sim.orderChaos)}
        </span>
      </div>
      <canvas
        ref={canvasRef}
        data-testid={`matrix-canvas-${sim.seed}-${sim.orderChaos}`}
        style={{
          display: 'block',
          width: '100%',
          aspectRatio: '1 / 1',
          border: '1px solid rgba(130, 184, 224, 0.25)',
          imageRendering: 'pixelated',
        }}
      />
      <div style={{ fontSize: 11, color: '#BDD0E4', lineHeight: 1.4 }}>
        {t.wallRing} #{lastFrame.wallGeneration} | {t.buildings}: {lastFrame.buildingsCount} |{' '}
        {(b.enclosedShareOfMap * 100).toFixed(0)}% {t.tilesUnit}
        <br />
        {t.straightness}: {(sim.city.metrics.roadStraightness * 100).toFixed(0)}% | {t.gridAlign}:{' '}
        {(sim.city.metrics.gridAlignmentRatio * 100).toFixed(0)}%
      </div>
    </div>
  );
}

function Stage3CityApp() {
  const initial = useMemo(() => readInitialQuery(), []);
  const [lang, setLang] = useState<Lang>(initial.lang);
  const [packId, setPackId] = useState<string>(initial.packId);
  const [mode, setMode] = useState<ViewMode>(initial.mode);
  const [seed, setSeed] = useState<string>(SIM_SEEDS[0]);
  const [knob, setKnob] = useState<number>(0.5);
  const [monthIdx, setMonthIdx] = useState<number>(59);
  const [playing, setPlaying] = useState<boolean>(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const activePack = useMemo(
    () => AVAILABLE_PACKS.find(p => p.id === packId) ?? AVAILABLE_PACKS[0]!,
    [packId],
  );

  const activeSim = useMemo(
    () => runFiveYearSimulation(activePack, { seed, mapSize: 150, orderChaos: knob, recordSnapshots: true }),
    [activePack, seed, knob],
  );

  const matrixSims = useMemo(() => {
    if (mode !== 'matrix') return [];
    const out: FiveYearSimResult[] = [];
    for (const s of SIM_SEEDS) {
      for (const k of SIM_KNOBS) {
        out.push(runFiveYearSimulation(activePack, { seed: s, mapSize: 150, orderChaos: k, recordSnapshots: true }));
      }
    }
    return out;
  }, [mode, activePack]);

  const frame = activeSim.frames[Math.max(0, Math.min(activeSim.frames.length - 1, monthIdx))]!;

  useEffect(() => {
    if (mode !== 'timelapse') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderCitySnapshot(canvas, activeSim.map, frame.snapshot, activePack, 4);
  }, [mode, activeSim, activePack, frame]);

  useEffect(() => {
    if (!playing || mode !== 'timelapse') return;
    const id = window.setInterval(() => {
      setMonthIdx(prev => (prev >= activeSim.frames.length - 1 ? 0 : prev + 1));
    }, 180);
    return () => window.clearInterval(id);
  }, [playing, mode, activeSim.frames.length]);

  useEffect(() => {
    window.__WORLD_CITY_SIM__ = {
      setPack: nextPack => {
        if (AVAILABLE_PACKS.some(p => p.id === nextPack)) setPackId(nextPack);
      },
      setMode: nextMode => setMode(nextMode),
      setSeed: nextSeed => setSeed(nextSeed),
      setKnob: nextKnob => setKnob(nextKnob),
      setMonth: m => setMonthIdx(Math.max(0, Math.min(59, m - 1))),
      setLang: nextLang => setLang(nextLang),
      getCurrentSummary: () => ({
        packId: activePack.id,
        seed,
        orderChaos: knob,
        month: frame.month,
        agents: frame.agents,
        tasks: frame.acceptedTasks,
        goals: frame.majorGoals,
        wallGeneration: frame.wallGeneration,
        buildings: frame.buildingsCount,
        excavatedTiles: frame.excavatedTiles,
        breakdown: frame.breakdown,
      }),
    };
    return () => {
      delete window.__WORLD_CITY_SIM__;
    };
  }, [activePack.id, seed, knob, frame]);

  const t = COPY[lang];
  const bd = frame.breakdown;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#111821',
        color: '#E7F0F9',
        padding: '14px 18px 24px',
        boxSizing: 'border-box',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 10,
          marginBottom: 10,
        }}
      >
        <div>
          <h1 data-testid="stage3-title" style={{ margin: 0, fontSize: 18, color: '#9BD9FF' }}>
            {t.title} ({packText(activePack.name, lang)})
          </h1>
          <div style={{ fontSize: 12.5, color: '#A5B9CE', marginTop: 3 }}>{t.subtitle}</div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#99B2CA' }}>{t.packLabel}:</span>
          {AVAILABLE_PACKS.map(p => (
            <button
              key={p.id}
              type="button"
              data-testid={`pack-${p.id}`}
              onClick={() => setPackId(p.id)}
              style={btnStyle(packId === p.id, '#FFE08A')}
            >
              {packText(p.name, lang)}
            </button>
          ))}
          <button
            type="button"
            data-testid="mode-timelapse"
            onClick={() => setMode('timelapse')}
            style={btnStyle(mode === 'timelapse')}
          >
            {t.modeTimelapse}
          </button>
          <button
            type="button"
            data-testid="mode-matrix"
            onClick={() => setMode('matrix')}
            style={btnStyle(mode === 'matrix')}
          >
            {t.modeMatrix}
          </button>
          <button type="button" data-testid="lang-ru" onClick={() => setLang('ru')} style={btnStyle(lang === 'ru')}>
            RU
          </button>
          <button type="button" data-testid="lang-en" onClick={() => setLang('en')} style={btnStyle(lang === 'en')}>
            EN
          </button>
        </div>
      </div>

      {mode === 'timelapse' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(480px, 600px) minmax(300px, 1fr)', gap: 16, alignItems: 'start' }}>
          <div>
            <canvas
              ref={canvasRef}
              data-testid="stage3-timelapse-canvas"
              style={{
                display: 'block',
                width: '100%',
                aspectRatio: '1 / 1',
                border: '1px solid rgba(130, 184, 224, 0.35)',
                imageRendering: 'pixelated',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
              <button
                type="button"
                data-testid="stage3-play-toggle"
                onClick={() => setPlaying(p => !p)}
                style={btnStyle(playing)}
              >
                {playing ? t.pause : t.play}
              </button>
              <input
                type="range"
                min={1}
                max={60}
                value={frame.month}
                onChange={e => setMonthIdx(Number(e.target.value) - 1)}
                style={{ flex: 1 }}
              />
              <span
                data-testid="stage3-clock"
                style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  fontSize: 13,
                  color: '#FFE08A',
                  minWidth: 112,
                  textAlign: 'right',
                }}
              >
                {t.year} {frame.year} / {t.month} {frame.month}
              </span>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gap: 10,
              padding: 12,
              background: '#19222E',
              border: '1px solid rgba(130, 184, 224, 0.28)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 12,
            }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span style={{ color: '#99B2CA' }}>{t.seedLabel}:</span>
              {SIM_SEEDS.map(s => (
                <button key={s} type="button" onClick={() => setSeed(s)} style={btnStyle(seed === s)}>
                  {s}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span style={{ color: '#99B2CA' }}>{t.knobLabel}:</span>
              {SIM_KNOBS.map(k => (
                <button key={k} type="button" onClick={() => setKnob(k)} style={btnStyle(knob === k)}>
                  {t.knobNames[String(k)]}
                </button>
              ))}
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '4px 12px',
                padding: '8px 10px',
                background: 'rgba(12, 18, 26, 0.72)',
                border: '1px solid rgba(130, 184, 224, 0.2)',
              }}
            >
              <div>{t.agents}: <strong style={{ color: '#9BD9FF' }}>{frame.agents}</strong></div>
              <div>{t.tasks}: <strong style={{ color: '#9BD9FF' }}>{frame.acceptedTasks.toLocaleString()}</strong></div>
              <div>{t.goals}: <strong style={{ color: '#FFE08A' }}>{frame.majorGoals}</strong></div>
              <div>{t.statues}: <strong style={{ color: '#F7FAFF' }}>{frame.statues}</strong></div>
              <div>{t.buildings}: <strong>{frame.buildingsCount}</strong></div>
              <div>{t.wallRing}: <strong>#{frame.wallGeneration}</strong></div>
              <div>{t.densified}: <strong>{frame.densifiedUpgrades}</strong></div>
              <div>{t.merged}: <strong>{frame.mergedBuildings}</strong></div>
              <div>{t.oldWallRoads}: <strong>{frame.snapshot.metrics.oldWallRoadsCreated}</strong></div>
              <div>{t.bridges}: <strong>{frame.snapshot.metrics.bridgeTiles}</strong></div>
              <div>{t.straightness}: <strong>{(frame.snapshot.metrics.roadStraightness * 100).toFixed(0)}%</strong></div>
              <div>
                {frame.excavatedTiles > 0
                  ? <>{t.excavated}: <strong style={{ color: '#C6B7FF' }}>{frame.excavatedTiles}</strong></>
                  : <>{t.gridAlign}: <strong>{(frame.snapshot.metrics.gridAlignmentRatio * 100).toFixed(0)}%</strong></>}
              </div>
            </div>

            <div
              data-testid="stage3-area-breakdown"
              style={{
                padding: '8px 10px',
                background: 'rgba(12, 18, 26, 0.72)',
                border: '1px solid rgba(130, 184, 224, 0.2)',
                fontSize: 11,
                lineHeight: 1.45,
              }}
            >
              <div style={{ color: '#FFE08A', fontWeight: 700, marginBottom: 4 }}>{t.areaTitle}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 8px' }}>
                {ALL_BUILDING_KINDS.map(kind => (
                  <div key={kind} style={{ display: 'contents' }}>
                    <span style={{ color: '#C4D6E8' }}>
                      {t.kindNames[kind]} ({bd.byKind[kind].count})
                    </span>
                    <strong style={{ textAlign: 'right' }}>
                      {bd.byKind[kind].tiles} {t.tilesUnit}
                    </strong>
                  </div>
                ))}
                <span style={{ color: '#A5C0DC' }}>{t.lotsLabel}</span>
                <strong style={{ textAlign: 'right' }}>{bd.reservedLotTiles} {t.tilesUnit}</strong>
                <span style={{ color: '#A5C0DC' }}>{t.roadsLabel}</span>
                <strong style={{ textAlign: 'right' }}>{bd.roadsTotalTiles} {t.tilesUnit}</strong>
                <span style={{ color: '#A5C0DC' }}>{t.wallLabel}</span>
                <strong style={{ textAlign: 'right' }}>{bd.wallTiles} {t.tilesUnit}</strong>
                <span style={{ color: '#9BD9FF', paddingTop: 4 }}>{t.activeTotal}</span>
                <strong style={{ color: '#9BD9FF', textAlign: 'right', paddingTop: 4 }}>
                  {bd.activeCityTiles} ({(bd.activeShareOfMap * 100).toFixed(1)}%)
                </strong>
                <span style={{ color: '#FFE08A' }}>{t.enclosedTotal}</span>
                <strong style={{ color: '#FFE08A', textAlign: 'right' }}>
                  {bd.enclosedHullTiles} ({(bd.enclosedShareOfMap * 100).toFixed(1)}%)
                </strong>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 10px', fontSize: 11, color: '#C8D8E8' }}>
              {t.legend.map(item => (
                <span key={item.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 10, height: 10, background: item.color, border: '1px solid rgba(255,255,255,0.3)' }} />
                  {item.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(260px, 1fr))', gap: 12 }}>
          {matrixSims.map(sim => (
            <MatrixCard key={`${sim.seed}-${sim.orderChaos}`} sim={sim} pack={activePack} lang={lang} />
          ))}
        </div>
      )}
    </div>
  );
}

function btnStyle(active: boolean, activeColor = '#9BD9FF'): React.CSSProperties {
  return {
    padding: '5px 10px',
    background: active ? '#284560' : '#182330',
    color: active ? activeColor : '#DCE8F5',
    border: '1px solid rgba(130, 184, 224, 0.35)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12,
    cursor: 'pointer',
  };
}

createRoot(document.getElementById('root')!).render(<Stage3CityApp />);
