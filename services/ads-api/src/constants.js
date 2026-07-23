// Shared domain constants for the Ads API. Values here are league/artwork facts
// from DESIGN.md §4/§5; prices, deadline, and model id live in config (per-season).

// The 18 GPSA teams competing this season (2026 divisions), plus GPSA for a
// league-level ad. Used both as the affiliation enum and to gate payment method.
export const TEAMS = [
  'Beaconsdale',
  'Colony',
  'Coventry',
  'Elizabeth Lake',
  'Glendale',
  'Hidenwood',
  'James River',
  'Kiln Creek',
  'Marlbank',
  'Poquoson',
  'Riverdale',
  'Running Man',
  'Village Green',
  'Warwick Yacht',
  'Wendwood',
  'Willow Oaks',
  'Windy Point',
  'Wythe',
];

export const AFFILIATIONS = [...TEAMS, 'GPSA'];

export const PLACEMENTS = ['FULL_SCREEN', 'HALF_SCREEN'];

export const PAYMENT_METHODS = ['PAY_TEAM', 'CHECK', 'SQUARE_INVOICE'];

export const CONTENT_TYPES = ['image/png', 'image/jpeg'];

// Locked 150-DPI validation targets (DESIGN.md §5). Aspect is fixed regardless of
// export DPI; artwork at or above the target with the right aspect passes.
// We validate the aspect RATIO only, not resolution. A correctly-proportioned ad is
// accepted at any pixel size — if a submitter ships a low-res file, that's on them, and
// the scoreboard scales it. (Templates still export high-res so it looks sharp.)
export const PLACEMENT_SPECS = {
  FULL_SCREEN: { aspect: 9 / 4, label: 'full-screen (18×8″, 9:4)' },
  HALF_SCREEN: { aspect: 9 / 8, label: 'half-screen (9×8″, 9:8)' },
};

// Aspect must be within ±1% of the placement's aspect.
export const ASPECT_TOLERANCE = 0.02;

export const STATUS = Object.freeze({
  AWAITING_UPLOAD: 'AWAITING_UPLOAD',
  VALIDATING: 'VALIDATING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
});
