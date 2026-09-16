// Deterministic dataset. Same seed => same data on every machine.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260907);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));

const STATUSES = ['draft', 'in_review', 'approved', 'archived'];
const KINDS = ['image', 'video', 'document'];

const TAGS = [
  'hero', 'campaign-spring', 'campaign-winter', 'ugc', 'lifestyle', 'product-shot',
  'studio', 'outdoor', 'talent-release', 'expiring', 'retouched', 'raw',
  'social-vertical', 'social-square', 'print', 'localised-de', 'localised-jp',
  'accessibility-reviewed', 'legal-hold', 'archive-candidate',
];

const SUBJECTS = [
  'Trail Runner', 'Kitchen Table', 'Rooftop Garden', 'Warehouse Floor', 'Cold Brew',
  'Studio Portrait', 'Bike Commute', 'Weekend Market', 'Desk Setup', 'Night Bus',
  'Harbour Walk', 'Rain Jacket', 'Ceramic Mug', 'Linen Shirt', 'Field Notes',
  'Loading Dock', 'Corner Shop', 'Summer Picnic', 'Winter Coat', 'Paper Map',
];

const MODIFIERS = [
  'Final', 'Alt', 'Cutdown', 'Master', 'Reframe', 'v2', 'v3', 'Pickup',
  'Approved Edit', 'Client Review', 'Unretouched', 'Wide', 'Tight', 'Overhead',
];

const OWNERS = [
  { id: 'u_01', name: 'Anika Rao' },
  { id: 'u_02', name: 'Bruno Salgado' },
  { id: 'u_03', name: 'Chen Wei' },
  { id: 'u_04', name: 'Dara Okafor' },
  { id: 'u_05', name: 'Elif Demir' },
  { id: 'u_06', name: 'Farid Haddad' },
  { id: 'u_07', name: 'Greta Lindqvist' },
  { id: 'u_08', name: 'Hiro Tanaka' },
];

export const COLLECTIONS = [
  { id: 'c_brand', name: 'Brand library' },
  { id: 'c_spring', name: 'Spring campaign' },
  { id: 'c_winter', name: 'Winter campaign' },
  { id: 'c_social', name: 'Social cutdowns' },
  { id: 'c_press', name: 'Press kit' },
  { id: 'c_legal', name: 'Legal review queue' },
];

const TOTAL = 12_400;
const DAY = 86_400_000;
// Fixed clock so createdAt/updatedAt are stable across runs.
const EPOCH = Date.UTC(2026, 8, 1, 9, 0, 0);

function makeAsset(i) {
  const kind = pick(KINDS);
  const name = `${pick(SUBJECTS)} ${pick(MODIFIERS)} MV-${String(i).padStart(5, '0')}`;
  const tagCount = int(0, 4);
  const tags = [];
  for (let t = 0; t < tagCount; t++) {
    const tag = pick(TAGS);
    if (!tags.includes(tag)) tags.push(tag);
  }
  const createdAt = EPOCH - int(0, 900) * DAY - int(0, DAY);
  const updatedAt = createdAt + int(0, 120) * DAY;

  const asset = {
    id: `a_${String(i).padStart(5, '0')}`,
    name,
    kind,
    status: pick(STATUSES),
    tags,
    collectionId: pick(COLLECTIONS).id,
    owner: pick(OWNERS),
    sizeBytes: kind === 'video' ? int(8e6, 900e6) : kind === 'image' ? int(180e3, 42e6) : int(20e3, 6e6),
    width: kind === 'document' ? null : pick([1080, 1440, 1920, 2160, 3840, 4096]),
    height: kind === 'document' ? null : pick([1080, 1350, 1440, 1920, 2160, 2560]),
    durationSec: kind === 'video' ? int(4, 900) : null,
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    version: 1,
    // Some thumbnails are intentionally missing. The UI has to cope.
    hasThumbnail: rand() > 0.04,
  };
  return asset;
}

/** @type {Map<string, ReturnType<typeof makeAsset>>} */
export const assets = new Map();
for (let i = 1; i <= TOTAL; i++) {
  const a = makeAsset(i);
  assets.set(a.id, a);
}

export const ALL_TAGS = [...TAGS].sort();
export const ALL_OWNERS = OWNERS;
export const ASSET_STATUSES = STATUSES;
export const ASSET_KINDS = KINDS;

// Palette for generated thumbnails, keyed off the id so it is stable.
export function thumbColors(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return { a: `hsl(${h} 52% 34%)`, b: `hsl(${(h + 42) % 360} 46% 62%)` };
}
