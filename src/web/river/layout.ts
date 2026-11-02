import type { Person, Stage } from '../../shared/types.js';

/** The four lanes of the river, left to right: the way a person gets closer to you. */
export const STAGE_ORDER: Stage[] = ['stranger', 'hello', 'following', 'talking'];

export const STAGE_LABEL: Record<Stage, string> = {
  stranger: 'Strangers',
  hello: 'Said hello',
  following: 'Following up',
  talking: 'Talking',
};

/** Faces grow as people get closer. */
export const FACE_SIZE: Record<Stage, number> = { stranger: 22, hello: 26, following: 30, talking: 34 };

export interface FaceItem { kind: 'face'; person: Person; x: number; y: number; size: number }
export interface GroupItem { kind: 'group'; stage: Stage; count: number; x: number; y: number; size: number }
export type RiverItem = FaceItem | GroupItem;

export interface RiverLayout {
  items: RiverItem[];
  /** People who replied and wait on you, oldest reply first. They sit above the river, not in it. */
  dock: Person[];
  /** How many people each lane holds (drawn as faces or as a group). */
  counts: Record<Stage, number>;
}

export interface RiverLayoutOptions {
  /** More faces than this collapse each lane into one group bubble. Default 60. */
  groupAbove?: number;
  /** Decides whether a snoozed person is due back. Without it every snoozed person counts as due. */
  now?: Date;
}

interface Lane { x0: number; x1: number; rows: number; cols: number; step: number }

/** Where each lane sits, as percentages of the river's width. Same lanes as the boards. */
const LANES: Record<Stage, Lane> = {
  stranger: { x0: 5, x1: 24, rows: 4, cols: 10, step: 0.135 },
  hello: { x0: 28, x1: 48, rows: 4, cols: 9, step: 0.135 },
  following: { x0: 52, x1: 72, rows: 4, cols: 5, step: 0.135 },
  talking: { x0: 76, x1: 93, rows: 3, cols: 4, step: 0.18 },
};

/** The same small hash the Marble uses, so a person's spot never depends on anything but their id. */
function hash(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

type Where = 'dock' | 'river' | 'nowhere';

function whereIs(p: Person, now: Date | undefined): Where {
  switch (p.status) {
    case 'waiting':
      return 'dock';
    case 'snoozed':
      return !now || !p.snoozedUntil || Date.parse(p.snoozedUntil) <= now.getTime() ? 'dock' : 'nowhere';
    case 'active':
    case 'held':
      return 'river';
    default:
      return 'nowhere';
  }
}

function byReply(a: Person, b: Person): number {
  const ta = a.repliedAt ? Date.parse(a.repliedAt) : Number.POSITIVE_INFINITY;
  const tb = b.repliedAt ? Date.parse(b.repliedAt) : Number.POSITIVE_INFINITY;
  return ta === tb ? a.id - b.id : ta - tb;
}

interface Slot { x: number; yf: number; order: number }

/** Below this width the lanes are narrow, so faces shrink a little and stack in more rows. */
const NARROW = 600;

function slotsFor(stage: Stage, count: number, narrow: boolean): Slot[] {
  const base = LANES[stage];
  const lane: Lane = narrow && base.rows >= 4 ? { ...base, rows: 6, step: 0.095, ...(stage === 'stranger' ? { x0: 4, x1: 29 } : {}) } : base;
  const laneIndex = STAGE_ORDER.indexOf(stage);
  const cols = Math.max(lane.cols, Math.ceil(count / lane.rows));
  const cw = (lane.x1 - lane.x0) / cols;
  const slots: Slot[] = [];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < lane.rows; r++) {
      const k = laneIndex * 1000 + c * 10 + r;
      slots.push({
        x: lane.x0 + (c + 0.5) * cw + (hash(k * 3.1 + 1) - 0.5) * cw * 0.35,
        yf: 0.3 + r * lane.step + (c % 2) * 0.045 + (hash(k * 5.7 + 2) - 0.5) * 0.03,
        order: hash(k * 13.37 + 5),
      });
    }
  }
  return slots.sort((a, b) => a.order - b.order);
}

/**
 * Where everyone goes. Faces keep a spot picked from their id, and only slide to the next free spot when another face
 * already holds theirs, so someone leaving a lane does not shuffle the rest.
 */
export function riverLayout(people: Person[], width: number, height: number, opts: RiverLayoutOptions = {}): RiverLayout {
  const groupAbove = opts.groupAbove ?? 60;
  const dock: Person[] = [];
  const lanes: Record<Stage, Person[]> = { stranger: [], hello: [], following: [], talking: [] };
  for (const p of people) {
    const where = whereIs(p, opts.now);
    if (where === 'dock') dock.push(p);
    else if (where === 'river') lanes[p.stage].push(p);
  }
  dock.sort(byReply);

  const counts: Record<Stage, number> = {
    stranger: lanes.stranger.length, hello: lanes.hello.length, following: lanes.following.length, talking: lanes.talking.length,
  };
  const total = STAGE_ORDER.reduce((sum, s) => sum + counts[s], 0);
  const items: RiverItem[] = [];

  if (total > groupAbove) {
    for (const stage of STAGE_ORDER) {
      const count = counts[stage];
      if (count === 0) continue;
      const lane = LANES[stage];
      items.push({
        kind: 'group', stage, count,
        x: ((lane.x0 + lane.x1) / 2 / 100) * width,
        y: height * 0.55,
        size: 48 + Math.min(24, Math.round(Math.sqrt(count) * 3)),
      });
    }
    return { items, dock, counts };
  }

  for (const stage of STAGE_ORDER) {
    const group = lanes[stage].slice().sort((a, b) => a.id - b.id);
    if (group.length === 0) continue;
    const narrow = width < NARROW;
    const slots = slotsFor(stage, group.length, narrow);
    const taken = new Set<number>();
    for (const person of group) {
      let at = Math.floor(hash(person.id * 7.7 + 3) * slots.length) % slots.length;
      while (taken.has(at)) at = (at + 1) % slots.length;
      taken.add(at);
      const slot = slots[at]!;
      items.push({ kind: 'face', person, x: (slot.x / 100) * width, y: slot.yf * height, size: narrow ? Math.round(FACE_SIZE[stage] * 0.82) : FACE_SIZE[stage] });
    }
  }
  return { items, dock, counts };
}
