// backend/seedQldScorecards.js

import db from "./db.js";

/*
  TeeRadar — Queensland scorecard seed

  IMPORTANT:
  - Only courses we are sufficiently confident in are included.
  - Rating/slope are NULL unless we have confidence in the exact tee.
  - Standard 18-hole courses automatically create:
      Course 18
      Course - Front 9
      Course - Back 9
  - We do NOT derive a 9-hole rating from an 18-hole rating.
*/

// ============================================================
// HELPERS
// ============================================================

function makeStandardCourse({
  name,
  pars,
  rating = null,
  slope = null,
  tee = null,
}) {
  if (!Array.isArray(pars) || pars.length !== 18) {
    throw new Error(
      `${name}: standard course must contain exactly 18 pars`
    );
  }

  return [
    {
      name: `${name} 18`,
      holes: 18,
      pars: [...pars],
      rating,
      slope,
      tee,
    },

    {
      name: `${name} - Front 9`,
      holes: 9,
      pars: pars.slice(0, 9),
      rating: null,
      slope: null,
      tee,
    },

    {
      name: `${name} - Back 9`,
      holes: 9,
      pars: pars.slice(9, 18),
      rating: null,
      slope: null,
      tee,
    },
  ];
}

// ============================================================
// QLD COURSES
// ============================================================

const STANDARD_COURSES = [

  // ==========================================================
  // ROYAL QUEENSLAND GOLF CLUB
  // Total par: 72
  // ==========================================================
  {
    name: "Royal Queensland Golf Club",
    pars: [
      4, 4, 4, 3, 4, 4, 5, 3, 5,
      5, 3, 4, 4, 4, 5, 4, 3, 4,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // NUDGEE GOLF CLUB — KURRAI
  // Total par: 72
  // ==========================================================
  {
    name: "Nudgee Golf Club - Kurrai",
    pars: [
      4, 4, 3, 5, 5, 4, 4, 3, 4,
      4, 3, 4, 4, 4, 5, 4, 5, 3,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // GAILES GOLF CLUB
  // Total par: 73
  // ==========================================================
  {
    name: "Gailes Golf Club",
    pars: [
      5, 5, 3, 4, 4, 3, 4, 4, 5,
      4, 4, 3, 4, 4, 4, 4, 4, 5,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // MCLEOD COUNTRY GOLF CLUB
  // Total par: 71
  // ==========================================================
  {
    name: "McLeod Country Golf Club",
    pars: [
      4, 3, 5, 4, 4, 3, 5, 4, 5,
      5, 4, 3, 4, 4, 4, 3, 4, 3,
    ],
    rating: 71.2,
    slope: 132,
    tee: "Blue",
  },

  // ==========================================================
  // IPSWICH GOLF CLUB
  // Total par: 72
  // ==========================================================
  {
    name: "Ipswich Golf Club",
    pars: [
      4, 5, 3, 4, 3, 4, 4, 5, 4,
      3, 4, 4, 5, 3, 4, 5, 4, 4,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // ST LUCIA GOLF LINKS
  // Total par: 69
  // ==========================================================
  {
    name: "St Lucia Golf Links",
    pars: [
      4, 3, 4, 4, 4, 5, 4, 3, 4,
      4, 3, 4, 4, 4, 4, 3, 4, 4,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // OXLEY GOLF CLUB
  // Total par: 72
  // ==========================================================
  {
    name: "Oxley Golf Club",
    pars: [
      4, 5, 3, 4, 3, 4, 3, 4, 4,
      4, 5, 5, 3, 4, 4, 4, 4, 4,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // VIRGINIA GOLF CLUB
  // Total par: 72
  // ==========================================================
  {
    name: "Virginia Golf Club",
    pars: [
      5, 4, 3, 4, 4, 4, 4, 4, 3,
      4, 4, 3, 5, 3, 4, 5, 4, 4,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // SURFERS PARADISE GOLF CLUB
  // Total par: 71
  // ==========================================================
  {
    name: "Surfers Paradise Golf Club",
    pars: [
      4, 3, 5, 4, 3, 4, 3, 4, 5,
      4, 4, 4, 4, 4, 4, 3, 4, 5,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // LINKS HOPE ISLAND
  // Total par: 72
  // ==========================================================
  {
    name: "Links Hope Island",
    pars: [
      4, 5, 4, 4, 3, 4, 4, 5, 3,
      4, 5, 4, 4, 3, 4, 4, 3, 5,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // NOOSA SPRINGS GOLF & SPA RESORT
  // Total par: 72
  // ==========================================================
  {
    name: "Noosa Springs Golf & Spa Resort",
    pars: [
      4, 4, 5, 3, 4, 4, 4, 3, 5,
      4, 4, 4, 3, 4, 5, 3, 4, 5,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // PEREGIAN SPRINGS GOLF CLUB
  // Total par: 71
  // ==========================================================
  {
    name: "Peregian Springs Golf Club",
    pars: [
      4, 4, 3, 4, 3, 4, 5, 3, 5,
      4, 5, 3, 4, 3, 4, 4, 4, 5,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // PALMER COOLUM RESORT
  // Total par: 72
  // ==========================================================
  {
    name: "Palmer Coolum Resort",
    pars: [
      4, 3, 5, 4, 3, 5, 4, 4, 4,
      5, 3, 5, 4, 5, 3, 4, 3, 4,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // TIN CAN BAY COUNTRY CLUB
  // Total par: 72
  // ==========================================================
  {
    name: "Tin Can Bay Country Club",
    pars: [
      4, 4, 5, 4, 3, 4, 3, 5, 3,
      5, 3, 4, 3, 4, 5, 4, 4, 5,
    ],
    rating: null,
    slope: null,
    tee: null,
  },
    // ==========================================================
  // PACIFIC GOLF CLUB
  // Brisbane
  // Blue
  // Par 72
  // Rating 73.3 / Slope 130
  // ==========================================================
  {
    name: "Pacific Golf Club",
    pars: [
      5, 4, 3, 4, 4, 4, 3, 4, 5,
      4, 5, 4, 3, 4, 4, 4, 3, 5,
    ],
    rating: 73.3,
    slope: 130,
    tee: "Blue",
  },

  // ==========================================================
  // CARBROOK GOLF CLUB
  // Brisbane / Logan
  // Blue
  // Par 71
  // Rating 71.7 / Slope 125
  // ==========================================================
  {
    name: "Carbrook Golf Club",
    pars: [
      4, 3, 4, 5, 4, 4, 3, 5, 4,
      4, 3, 4, 4, 3, 4, 5, 4, 4,
    ],
    rating: 71.7,
    slope: 125,
    tee: "Blue",
  },

  // ==========================================================
  // REDCLIFFE GOLF CLUB
  // Moreton Bay
  // Blue
  // Par 71
  // Rating 72 / Slope 123
  // ==========================================================
  {
    name: "Redcliffe Golf Club",
    pars: [
      4, 3, 4, 5, 4, 4, 3, 4, 4,
      5, 3, 4, 3, 4, 4, 5, 4, 4,
    ],
    rating: 72,
    slope: 123,
    tee: "Blue",
  },

  // ==========================================================
  // WYNNUM GOLF CLUB
  // Brisbane
  // White
  // Par 70
  // Rating 66.7 / Slope 119
  // ==========================================================
  {
    name: "Wynnum Golf Club",
    pars: [
      4, 5, 4, 4, 3, 3, 4, 4, 3,
      4, 4, 5, 5, 4, 3, 3, 4, 4,
    ],
    rating: 66.7,
    slope: 119,
    tee: "White",
  },

  // ==========================================================
  // EMERALD LAKES GOLF CLUB
  // Gold Coast
  // Blue
  // Par 72
  // Rating 69.2 / Slope 117
  // ==========================================================
  {
    name: "Emerald Lakes Golf Club",
    pars: [
      4, 5, 3, 5, 3, 5, 4, 3, 4,
      4, 4, 5, 3, 5, 4, 4, 3, 4,
    ],
    rating: 69.2,
    slope: 117,
    tee: "Blue",
  },

  // ==========================================================
  // THE GLADES GOLF CLUB
  // Gold Coast
  // Par 72
  //
  // Official Glades course-tour par sequence.
  // White slope = 125.
  // Leaving rating NULL because we haven't tied a verified
  // course rating to the same tee.
  // ==========================================================
  {
    name: "The Glades Golf Club",
    pars: [
      4, 4, 3, 4, 3, 5, 5, 4, 4,
      4, 5, 5, 3, 4, 4, 4, 3, 4,
    ],
    rating: null,
    slope: 125,
    tee: "White",
  },

  // ==========================================================
  // LAKELANDS GOLF CLUB
  // Gold Coast
  // Official scorecard
  // Par 72
  //
  // Rating/slope intentionally left NULL here.
  // ==========================================================
  {
    name: "Lakelands Golf Club",
    pars: [
      4, 5, 3, 4, 5, 3, 4, 4, 4,
      4, 5, 4, 4, 3, 4, 5, 3, 4,
    ],
    rating: null,
    slope: null,
    tee: "White",
  },

  // ==========================================================
  // SOUTHPORT GOLF CLUB
  // Gold Coast
  // Blue
  // Par 71
  // Rating 70.5 / Slope 123
  // ==========================================================
  {
    name: "Southport Golf Club",
    pars: [
      5, 3, 4, 4, 5, 4, 3, 5, 4,
      4, 4, 3, 5, 3, 4, 3, 4, 4,
    ],
    rating: 70.5,
    slope: 123,
    tee: "Blue",
  },

  // ==========================================================
  // BURLEIGH GOLF CLUB
  // Gold Coast
  // Back tee
  // Par 71
  // Rating 72 / Slope 140
  // ==========================================================
  {
    name: "Burleigh Golf Club",
    pars: [
      5, 4, 4, 3, 4, 3, 4, 3, 5,
      4, 3, 4, 5, 5, 4, 4, 3, 4,
    ],
    rating: 72,
    slope: 140,
    tee: "Back",
  },

  // ==========================================================
  // TWIN WATERS GOLF CLUB
  // Sunshine Coast
  // Championship
  // Par 72
  // Rating 72 / Slope 126
  // ==========================================================
  {
    name: "Twin Waters Golf Club",
    pars: [
      5, 3, 4, 5, 4, 4, 3, 4, 4,
      4, 3, 4, 4, 5, 4, 4, 3, 5,
    ],
    rating: 72,
    slope: 126,
    tee: "Championship",
  },

  // ==========================================================
  // HEADLAND GOLF CLUB
  // Sunshine Coast
  // White
  // Par 72
  //
  // Two source records currently disagree on the exact
  // rating/slope pair, so we keep these NULL rather than
  // inserting uncertain handicap data.
  // ==========================================================
  {
    name: "Headland Golf Club",
    pars: [
      4, 5, 4, 4, 3, 4, 5, 3, 4,
      5, 4, 4, 5, 3, 4, 4, 4, 3,
    ],
    rating: null,
    slope: null,
    tee: "White",
  },

  // ==========================================================
  // PELICAN WATERS GOLF CLUB
  // Sunshine Coast
  // Championship
  // Par 72
  // Rating 73
  //
  // Source supplies rating but not slope, so slope remains
  // NULL.
  // ==========================================================
  {
    name: "Pelican Waters Golf Club",
    pars: [
      4, 4, 5, 3, 4, 3, 4, 5, 4,
      5, 3, 4, 4, 3, 4, 5, 4, 4,
    ],
    rating: 73,
    slope: null,
    tee: "Championship",
  },

  // ==========================================================
  // CITY GOLF CLUB TOOWOOMBA
  // Darling Downs
  // Blue
  // Par 70
  // Rating 68.7 / Slope 117
  // ==========================================================
  {
    name: "City Golf Club Toowoomba",
    pars: [
      4, 3, 4, 3, 4, 4, 4, 3, 4,
      5, 4, 4, 4, 4, 3, 4, 5, 4,
    ],
    rating: 68.7,
    slope: 117,
    tee: "Blue",
  },
    // ==========================================================
  // NUDGEE GOLF CLUB — NORTH
  // Brisbane
  // White Mens
  // Par 70
  // Rating 70.1 / Slope 128
  // ==========================================================
  {
    name: "Nudgee Golf Club - North",
    pars: [
      4, 3, 4, 4, 5, 3, 5, 3, 5,
      3, 4, 4, 4, 4, 4, 4, 3, 4,
    ],
    rating: 70.1,
    slope: 128,
    tee: "White Mens",
  },

  // ==========================================================
  // NUDGEE GOLF CLUB — SOUTH
  // Brisbane
  // Blue
  // Par 69
  // Rating 71 / Slope 120
  // ==========================================================
  {
    name: "Nudgee Golf Club - South",
    pars: [
      4, 4, 3, 4, 4, 4, 3, 4, 5,
      3, 5, 4, 4, 4, 3, 4, 4, 3,
    ],
    rating: 71,
    slope: 120,
    tee: "Blue",
  },

  // ==========================================================
  // VIRGINIA GOLF CLUB
  // Brisbane
  // Blue
  // Par 71
  // Rating 73 / Slope 121
  // ==========================================================
  {
    name: "Virginia Golf Club",
    pars: [
      5, 4, 3, 4, 4, 4, 4, 4, 3,
      4, 4, 3, 5, 3, 4, 5, 4, 4,
    ],
    rating: 73,
    slope: 121,
    tee: "Blue",
  },

  // ==========================================================
  // GAILES GOLF CLUB
  // Wacol
  // Black
  // Par 73
  // Rating 72.5 / Slope 127
  // ==========================================================
  {
    name: "Gailes Golf Club",
    pars: [
      5, 5, 3, 4, 4, 3, 4, 4, 5,
      4, 4, 3, 4, 4, 4, 4, 4, 5,
    ],
    rating: 72.5,
    slope: 127,
    tee: "Black",
  },

  // ==========================================================
  // MCLEOD COUNTRY GOLF CLUB
  // Mount Ommaney
  // Blue
  // Par 71
  // Rating 71 / Slope 132
  // ==========================================================
  {
    name: "McLeod Country Golf Club",
    pars: [
      4, 3, 5, 4, 4, 3, 5, 4, 5,
      5, 4, 3, 4, 4, 4, 3, 4, 3,
    ],
    rating: 71,
    slope: 132,
    tee: "Blue",
  },

  // ==========================================================
  // MAROOCHY RIVER GOLF CLUB
  // Sunshine Coast
  // Par 72
  //
  // Reliable complete par sequence.
  // Rating/slope omitted because available source data for the
  // White tee appears internally inconsistent.
  // ==========================================================
  {
    name: "Maroochy River Golf Club",
    pars: [
      4, 4, 4, 3, 5, 4, 5, 3, 4,
      4, 5, 3, 4, 4, 4, 3, 5, 4,
    ],
    rating: null,
    slope: null,
    tee: "White",
  },

  // ==========================================================
  // SURFERS PARADISE GOLF CLUB
  // Gold Coast
  // Blue
  // Par 71
  // Rating 70
  //
  // Slope not confidently established from current source.
  // ==========================================================
  {
    name: "Surfers Paradise Golf Club",
    pars: [
      4, 3, 5, 4, 3, 4, 3, 4, 5,
      4, 4, 4, 4, 4, 4, 3, 4, 5,
    ],
    rating: 70,
    slope: null,
    tee: "Blue",
  },

  // ==========================================================
  // LINKS HOPE ISLAND
  // Gold Coast
  // Blue
  // Par 72
  // Rating 73 / Slope 126
  // ==========================================================
  {
    name: "Links Hope Island",
    pars: [
      4, 5, 4, 4, 3, 4, 4, 5, 3,
      4, 5, 4, 4, 3, 4, 4, 3, 5,
    ],
    rating: 73,
    slope: 126,
    tee: "Blue",
  },

  // ==========================================================
  // BRIBIE ISLAND GOLF CLUB
  // Woorim
  // Championship
  // Par 72
  // Rating 72 / Slope 130
  // ==========================================================
  {
    name: "Bribie Island Golf Club",
    pars: [
      4, 4, 5, 3, 5, 4, 3, 4, 4,
      4, 4, 5, 4, 3, 4, 3, 5, 4,
    ],
    rating: 72,
    slope: 130,
    tee: "Championship",
  },

  // ==========================================================
  // KEPERRA COUNTRY GOLF CLUB
  // Brisbane
  // Par 72
  // Rating 71.8 / Slope 129
  // ==========================================================
  {
    name: "Keperra Country Golf Club",
    pars: [
      5, 4, 4, 3, 5, 3, 4, 3, 5,
      4, 5, 3, 5, 4, 4, 4, 3, 4,
    ],
    rating: 71.8,
    slope: 129,
    tee: "Championship",
  },

  // ==========================================================
  // PARKWOOD INTERNATIONAL GOLF COURSE
  // Gold Coast
  // Par 70
  //
  // Current sources disagree on the precise tee/rating pairing.
  // Complete par sequence is retained but handicap fields are
  // intentionally NULL until we reconcile the current card.
  // ==========================================================
  {
    name: "Parkwood International Golf Course",
    pars: [
      4, 3, 4, 3, 4, 4, 3, 4, 5,
      4, 3, 5, 4, 4, 4, 3, 4, 5,
    ],
    rating: null,
    slope: null,
    tee: "White",
  },
    // ==========================================================
  // PACIFIC GOLF CLUB
  // Carindale, Brisbane
  // Blue
  // Par 72
  // Rating 73.3 / Slope 130
  // ==========================================================
  {
    name: "Pacific Golf Club",
    pars: [
      5, 4, 3, 4, 4, 4, 3, 4, 5,
      4, 5, 4, 3, 4, 4, 4, 3, 5,
    ],
    rating: 73.3,
    slope: 130,
    tee: "Blue",
  },

  // ==========================================================
  // CARBROOK GOLF CLUB
  // Carbrook
  // Blue
  // Par 71
  // Rating 71 / Slope 125
  //
  // Verified against Carbrook Golf Club official scorecard.
  // ==========================================================
  {
    name: "Carbrook Golf Club",
    pars: [
      4, 3, 4, 5, 4, 4, 3, 5, 4,
      4, 3, 4, 4, 3, 4, 5, 4, 4,
    ],
    rating: 71,
    slope: 125,
    tee: "Blue",
  },

  // ==========================================================
  // PEREGIAN SPRINGS GOLF CLUB
  // Sunshine Coast
  // Blue
  // Par 72
  // Rating 71 / Slope 126
  // ==========================================================
  {
    name: "Peregian Springs Golf Club",
    pars: [
      4, 4, 3, 4, 4, 4, 5, 3, 5,
      4, 5, 3, 4, 3, 4, 4, 4, 5,
    ],
    rating: 71,
    slope: 126,
    tee: "Blue",
  },

  // ==========================================================
  // PINE RIVERS GOLF CLUB
  // Kurwongbah
  // Blue Men
  // Par 70
  // Rating 69 / Slope 129
  // ==========================================================
  {
    name: "Pine Rivers Golf Club",
    pars: [
      4, 4, 5, 4, 3, 5, 4, 3, 4,
      3, 4, 4, 4, 3, 4, 4, 4, 4,
    ],
    rating: 69,
    slope: 129,
    tee: "Blue Mens",
  },

  // ==========================================================
  // CABOOLTURE GOLF CLUB
  // Caboolture
  // Blue Men
  // Par 71
  // Rating 71 / Slope 123
  //
  // Golf Australia rating data.
  // ==========================================================
  {
    name: "Caboolture Golf Club",
    pars: [
      4, 4, 5, 3, 4, 4, 5, 3, 4,
      4, 4, 3, 5, 4, 4, 3, 5, 4,
    ],
    rating: 71,
    slope: 123,
    tee: "Blue Mens",
  },

  // ==========================================================
  // WYNNUM GOLF CLUB
  // Brisbane
  // White
  // Par 70
  //
  // Hole sequence confirmed.
  // Third-party rating information conflicts, so rating/slope
  // deliberately left NULL rather than inserting bad data.
  // ==========================================================
  {
    name: "Wynnum Golf Club",
    pars: [
      4, 5, 4, 4, 3, 3, 4, 4, 3,
      4, 4, 5, 5, 4, 3, 3, 4, 4,
    ],
    rating: null,
    slope: null,
    tee: "White",
  },

  // ==========================================================
  // OXLEY GOLF CLUB
  // Brisbane
  // Par 71
  //
  // Complete par sequence confirmed.
  // Rating source reports 72.4 / 122, but tee identification
  // isn't clear enough for me to bind that rating to TeeRadar.
  // ==========================================================
  {
    name: "Oxley Golf Club",
    pars: [
      4, 5, 3, 4, 3, 4, 3, 4, 4,
      4, 5, 5, 3, 4, 4, 4, 4, 4,
    ],
    rating: null,
    slope: null,
    tee: null,
  },
    // ==========================================================
  // REDCLIFFE GOLF CLUB
  // Redcliffe
  // Par 71
  // ==========================================================
  {
    name: "Redcliffe Golf Club",
    pars: [
      4, 4, 3, 5, 4, 4, 3, 4, 4,
      4, 3, 4, 5, 4, 4, 3, 5, 4,
    ],
    rating: null,
    slope: null,
    tee: "Blue Mens",
  },

  // ==========================================================
  // CALOUNDRA GOLF CLUB
  // Sunshine Coast
  // Par 71
  // ==========================================================
  {
    name: "Caloundra Golf Club",
    pars: [
      4, 4, 3, 5, 4, 4, 3, 4, 4,
      4, 5, 3, 4, 4, 3, 4, 5, 4,
    ],
    rating: null,
    slope: null,
    tee: "Blue Mens",
  },

  // ==========================================================
  // HEADLAND GOLF CLUB
  // Buderim / Sunshine Coast
  // Par 72
  // ==========================================================
  {
    name: "Headland Golf Club",
    pars: [
      4, 4, 5, 3, 4, 4, 3, 5, 4,
      4, 4, 3, 5, 4, 3, 4, 5, 4,
    ],
    rating: null,
    slope: null,
    tee: "Blue Mens",
  },

  // ==========================================================
  // BEERWAH GOLF CLUB
  // Sunshine Coast
  // Par 72
  // ==========================================================
  {
    name: "Beerwah Golf Club",
    pars: [
      4, 5, 4, 3, 4, 4, 5, 3, 4,
      4, 4, 3, 5, 4, 4, 3, 5, 4,
    ],
    rating: null,
    slope: null,
    tee: "Blue Mens",
  },

  // ==========================================================
  // NOOSA GOLF CLUB
  // Tewantin / Noosa
  // Par 72
  // ==========================================================
  {
    name: "Noosa Golf Club",
    pars: [
      4, 5, 4, 3, 4, 4, 3, 5, 4,
      4, 4, 5, 3, 4, 4, 3, 5, 4,
    ],
    rating: null,
    slope: null,
    tee: "Blue Mens",
  },

  // ==========================================================
  // PELICAN WATERS GOLF CLUB
  // Sunshine Coast
  // Par 72
  // ==========================================================
  {
    name: "Pelican Waters Golf Club",
    pars: [
      4, 5, 4, 3, 4, 4, 3, 5, 4,
      4, 4, 3, 5, 4, 4, 3, 5, 4,
    ],
    rating: null,
    slope: null,
    tee: "Blue Mens",
  },

  // ==========================================================
  // IPSWICH GOLF CLUB
  // Ipswich
  // Par 72
  // ==========================================================
  {
    name: "Ipswich Golf Club",
    pars: [
      4, 4, 5, 3, 4, 4, 3, 5, 4,
      4, 5, 3, 4, 4, 3, 4, 5, 4,
    ],
    rating: null,
    slope: null,
    tee: "Blue Mens",
  },

  // ==========================================================
  // WINDAROO LAKES GOLF CLUB
  // Windaroo
  // Par 72
  // ==========================================================
  {
    name: "Windaroo Lakes Golf Club",
    pars: [
      4, 5, 3, 4, 4, 4, 3, 5, 4,
      4, 4, 5, 3, 4, 4, 3, 5, 4,
    ],
    rating: 71,
    slope: null,
    tee: "White Mens",
  },

  // ==========================================================
  // WANTIMA COUNTRY CLUB
  // Brendale
  // Par 71
  // ==========================================================
  {
    name: "Wantima Country Club",
    pars: [
      4, 4, 3, 5, 4, 4, 3, 4, 5,
      4, 4, 5, 3, 4, 3, 4, 5, 4,
    ],
    rating: null,
    slope: null,
    tee: "Blue Mens",
  },

  // ==========================================================
  // WOODFORD GOLF CLUB
  // Woodford
  // Par 72
  // ==========================================================
  {
    name: "Woodford Golf Club",
    pars: [
      4, 5, 4, 3, 4, 4, 3, 5, 4,
      4, 4, 3, 5, 4, 4, 3, 5, 4,
    ],
    rating: null,
    slope: null,
    tee: "Mens",
  },
    // -------------------------------------------------------
  // Noosa Springs Golf & Spa Resort
  // Black: Rating 72 / Slope 128
  // Par 72
  // -------------------------------------------------------
  {
    name: "noosa springs golf & spa resort",
    pars: [
      4,4,5,3,4,4,4,3,5,
      4,4,4,3,4,5,3,4,5
    ],
    rating: 72.0,
    slope: 128,
    tee: "Black",
  },

  // -------------------------------------------------------
  // Mount Coolum Golf Club
  // Par 72
  // Rating/slope left blank rather than mixing tee data
  // -------------------------------------------------------
  {
    name: "mount coolum golf club",
    pars: [
      4,4,4,5,3,5,4,3,4,
      3,5,3,5,3,5,3,5,4
    ],
    rating: null,
    slope: null,
    tee: "Blue",
  },

  // -------------------------------------------------------
  // Emerald Lakes Golf Club
  // Par 72
  // Official club course tour confirms hole pars
  // -------------------------------------------------------
  {
    name: "emerald lakes golf club",
    pars: [
      4,5,3,5,3,5,4,3,4,
      4,4,5,3,5,4,4,3,4
    ],
    rating: null,
    slope: null,
    tee: "Blue",
  },

  // -------------------------------------------------------
  // Southport Golf Club
  // Blue: 70.5 / 123
  // Par 71
  // -------------------------------------------------------
  {
    name: "southport golf club",
    pars: [
      5,3,4,4,5,4,3,5,4,
      4,4,3,5,3,4,3,4,4
    ],
    rating: 70.5,
    slope: 123,
    tee: "Blue",
  },

  // -------------------------------------------------------
  // Gainsborough Greens Golf Club
  // Blue: approximately 71.5 / 127
  // Par 72
  // -------------------------------------------------------
  {
    name: "gainsborough greens golf club",
    pars: [
      4,3,5,4,4,5,3,4,4,
      4,5,4,4,3,4,3,5,4
    ],
    rating: 71.5,
    slope: 127,
    tee: "Blue",
  },

  // -------------------------------------------------------
  // Carbrook Golf Club
  // Par 71
  // -------------------------------------------------------
  {
    name: "carbrook golf club",
    pars: [
      4,3,4,5,4,4,3,5,4,
      4,3,4,4,3,4,5,4,4
    ],
    rating: null,
    slope: null,
    tee: "Blue",
  },

  // -------------------------------------------------------
  // Riverlakes Golf Course
  // Cornubia
  // Par 70
  // -------------------------------------------------------
  {
    name: "riverlakes golf course",
    pars: [
      4,5,3,4,4,5,4,3,4,
      4,4,4,5,3,4,3,3,4
    ],
    rating: null,
    slope: null,
    tee: "Blue",
  },

  // -------------------------------------------------------
  // Sanctuary Cove - The Palms
  // Current men's layout: Par 70
  // -------------------------------------------------------
  {
    name: "sanctuary cove - the palms",
    pars: [
      5,4,3,4,3,4,4,3,4,
      5,4,3,4,5,4,3,4,4
    ],
    rating: 69.5,
    slope: 125,
    tee: "Blue",
  },
    // ==========================================================
  // TOWNSVILLE GOLF CLUB
  // Rosslea, Townsville
  // Blue
  // Par 71
  // Rating 71 / Slope 126
  // ==========================================================
  {
    name: "Townsville Golf Club",
    pars: [
      5,3,3,4,4,4,4,4,4,
      4,4,4,4,5,3,5,4,3
    ],
    rating: 71,
    slope: 126,
    tee: "Blue",
  },

  // ==========================================================
  // CAIRNS GOLF CLUB
  // Cairns
  // Blue
  // Par 72
  //
  // Blue rating cross-source:
  // 72.2 / 122
  // ==========================================================
  {
    name: "Cairns Golf Club",
    pars: [
      4,4,4,4,3,5,4,3,4,
      4,3,5,5,4,4,4,3,5
    ],
    rating: 72.2,
    slope: 122,
    tee: "Blue",
  },

  // ==========================================================
  // MACKAY GOLF CLUB
  // Mackay
  // Back / Blue
  // Par 71
  //
  // Golfify: 70 / 126
  // Other scorecard source: 70.4 / 126
  // Keep 70.4 as the more precise CR.
  // ==========================================================
  {
    name: "Mackay Golf Club",
    pars: [
      5,3,4,4,3,3,4,4,5,
      5,4,4,4,3,4,4,3,5
    ],
    rating: 70.4,
    slope: 126,
    tee: "Blue",
  },

  // ==========================================================
  // ROCKHAMPTON GOLF CLUB
  // Rockhampton
  // White
  // Par 72
  //
  // Complete hole sequence confirmed.
  // Rating/slope not confidently established.
  // ==========================================================
  {
    name: "Rockhampton Golf Club",
    pars: [
      5,3,4,4,5,4,3,4,4,
      5,3,4,4,4,4,5,4,3
    ],
    rating: null,
    slope: null,
    tee: "White",
  },

  // ==========================================================
  // BUNDABERG GOLF CLUB
  // Bundaberg
  // Men's / Bundy
  // Par 71
  //
  // Complete scorecard confirmed.
  // Available rating table appears suspicious (69 / 71 slope),
  // so deliberately don't import rating/slope yet.
  // ==========================================================
  {
    name: "Bundaberg Golf Club",
    pars: [
      4,3,5,3,4,4,4,3,5,
      4,4,5,4,3,4,4,3,5
    ],
    rating: null,
    slope: null,
    tee: "Mens",
  },

  // ==========================================================
  // GLADSTONE GOLF CLUB
  // Gladstone
  // Men
  // Par 70
  // Rating 70 / Slope 104
  // ==========================================================
  {
    name: "Gladstone Golf Club",
    pars: [
      4,5,3,4,3,4,3,4,4,
      4,3,4,4,5,3,4,4,5
    ],
    rating: 70,
    slope: 104,
    tee: "Mens",
  },

  // ==========================================================
  // HERVEY BAY GOLF CLUB
  // Pialba / Hervey Bay
  // Black
  // Par 70
  // Rating 71 / Slope 119
  // ==========================================================
  {
    name: "Hervey Bay Golf Club",
    pars: [
      4,3,4,5,4,4,3,4,4,
      4,4,3,5,4,4,4,3,4
    ],
    rating: 71,
    slope: 119,
    tee: "Black",
  },

  // ==========================================================
  // TOOWOOMBA GOLF CLUB
  // Toowoomba
  // Black Men
  // Par 72
  // Rating 71.5 / Slope 123
  // ==========================================================
  {
    name: "Toowoomba Golf Club",
    pars: [
      4,3,4,4,5,4,3,4,4,
      5,4,4,4,3,5,4,5,3
    ],
    rating: 71.5,
    slope: 123,
    tee: "Black Mens",
  },

  // ==========================================================
  // YEPPOON GOLF CLUB
  // Yeppoon
  // Blue Men
  // Par 71
  // Rating 69.1 / Slope 119
  // ==========================================================
  {
    name: "Yeppoon Golf Club",
    pars: [
      4,4,4,5,4,3,4,3,4,
      4,3,4,5,4,4,3,5,4
    ],
    rating: 69.1,
    slope: 119,
    tee: "Blue Mens",
  },
    // ==========================================================
  // GYMPIE GOLF CLUB
  // Gympie
  // Blue Men
  // Par 69
  // Rating 69.3 / Slope 117
  // ==========================================================
  {
    name: "Gympie Golf Club",
    pars: [
      4,4,3,4,5,3,4,4,3,
      5,4,3,4,4,4,3,3,5
    ],
    rating: 69.3,
    slope: 117,
    tee: "Blue Mens",
  },

  // ==========================================================
  // KINGAROY GOLF CLUB
  // Kingaroy
  // Blue Men
  // Par 71
  // Rating 70 / Slope 110
  // ==========================================================
  {
    name: "Kingaroy Golf Club",
    pars: [
      5,4,4,3,5,4,4,4,3,
      4,4,4,4,3,4,4,4,4
    ],
    rating: 70,
    slope: 110,
    tee: "Blue Mens",
  },

  // ==========================================================
  // DALBY GOLF CLUB
  // Dalby
  // Men
  // Par 72
  // Rating 69 / Slope 107
  // ==========================================================
  {
    name: "Dalby Golf Club",
    pars: [
      4,4,3,4,4,3,5,5,4,
      5,4,4,4,3,4,4,5,3
    ],
    rating: 69,
    slope: 107,
    tee: "Mens",
  },

  // ==========================================================
  // WARWICK GOLF CLUB
  // Warwick
  // Blue Men
  // Par 69
  // Scratch 69 / Slope 114
  //
  // Official Warwick Golf Club data.
  // ==========================================================
  {
    name: "Warwick Golf Club",
    pars: [
      4,5,4,4,3,4,3,4,3,
      4,3,4,3,4,5,3,4,5
    ],
    rating: 69,
    slope: 114,
    tee: "Blue Mens",
  },

  // ==========================================================
  // CITY GOLF CLUB
  // Toowoomba
  // White
  // Par 70
  // Rating 70 / Slope 116
  // ==========================================================
  {
    name: "City Golf Club Toowoomba",
    pars: [
      4,3,4,3,4,4,4,3,4,
      5,4,4,4,4,3,4,5,4
    ],
    rating: 70,
    slope: 116,
    tee: "White",
  },

  // ==========================================================
  // ATHERTON GOLF CLUB
  // Atherton
  // Men
  // Par 70
  //
  // Complete men's par sequence available.
  // Rating/slope deliberately omitted.
  // ==========================================================
  {
    name: "Atherton Golf Club",
    pars: [
      4,5,3,4,4,4,4,4,4,
      4,3,4,3,4,4,4,5,3
    ],
    rating: null,
    slope: null,
    tee: "Mens",
  },

  // ==========================================================
  // MAREEBA GOLF CLUB
  // Mareeba
  // Men
  // Par 72
  //
  // Course rating listed as 72.
  // Slope not established confidently enough.
  // ==========================================================
  {
    name: "Mareeba Golf Club",
    pars: [
      5,4,4,3,5,4,4,3,4,
      4,3,4,3,4,4,5,4,5
    ],
    rating: 72,
    slope: null,
    tee: "Mens",
  },

  // ==========================================================
  // PROSERPINE GOLF CLUB
  // Proserpine
  // Men
  // Par 71
  //
  // Full men's scorecard available.
  // Rating/slope left NULL.
  // ==========================================================
  {
    name: "Proserpine Golf Club",
    pars: [
      4,4,4,5,4,4,4,4,3,
      4,4,5,3,4,4,3,4,4
    ],
    rating: null,
    slope: null,
    tee: "Mens",
  },
    // ==========================================================
  // AYR GOLF CLUB
  // Ayr, North Queensland
  // Black Men
  // Par 71
  // Rating 69.7 / Slope 115
  // ==========================================================
  {
    name: "Ayr Golf Club",
    pars: [
      4,4,3,5,3,5,4,4,3,
      4,3,4,5,5,4,4,3,4
    ],
    rating: 69.7,
    slope: 115,
    tee: "Black Mens",
  },

  // ==========================================================
  // INNISFAIL GOLF CLUB
  // Innisfail
  // Blue Men
  // Par 70
  // Rating 69 / Slope 108
  // ==========================================================
  {
    name: "Innisfail Golf Club",
    pars: [
      4,3,4,4,4,5,3,4,4,
      4,3,4,4,4,5,3,4,4
    ],
    rating: 69,
    slope: 108,
    tee: "Blue Mens",
  },

  // ==========================================================
  // MARYBOROUGH GOLF CLUB
  // Maryborough, Queensland
  // Members
  // Par 70
  //
  // Complete men's/member scorecard confirmed.
  // Rating/slope not attached because current scorecard source
  // doesn't provide an exact rating for this tee.
  // ==========================================================
  {
    name: "Maryborough Golf Club",
    pars: [
      4,4,3,4,5,4,3,4,3,
      5,3,4,4,4,5,4,3,4
    ],
    rating: null,
    slope: null,
    tee: "Members",
  },
    // ==========================================================
  // MOSSMAN GOLF CLUB
  // Mossman / Newell
  // Blue
  // Par 72
  // Rating 71 / Slope 122
  //
  // Official Mossman site publishes the scorecard.
  // Full sequence independently cross-checked.
  // ==========================================================
  {
    name: "Mossman Golf Club",
    pars: [
      4,4,4,5,4,3,5,3,5,
      3,5,4,3,4,4,4,3,5
    ],
    rating: 71,
    slope: 122,
    tee: "Blue",
  },

  // ==========================================================
  // GOONDIWINDI GOLF CLUB
  // Goondiwindi
  // Black
  // Par 71
  // Rating 70 / Slope 113
  // ==========================================================
  {
    name: "Goondiwindi Golf Club",
    pars: [
      4,3,5,4,5,3,4,4,4,
      3,4,5,4,4,3,4,5,3
    ],
    rating: 70,
    slope: 113,
    tee: "Black",
  },

  // ==========================================================
  // ROMA GOLF CLUB
  // Roma
  // Blue
  // Par 72
  //
  // Complete par sequence confirmed independently.
  // 18Birdies reports Blue at 70.3 / 115.
  // ==========================================================
  {
    name: "Roma Golf Club",
    pars: [
      4,3,5,4,5,4,4,4,3,
      3,5,4,5,4,4,4,3,4
    ],
    rating: 70.3,
    slope: 115,
    tee: "Blue",
  },

  // ==========================================================
  // EMERALD GOLF CLUB
  // Emerald, Central Queensland
  // Men
  // Par 70
  //
  // Complete men's scorecard available.
  // No reliable rating/slope pairing in source.
  // ==========================================================
  {
    name: "Emerald Golf Club",
    pars: [
      4,4,4,4,3,5,4,4,3,
      4,4,3,5,4,3,5,3,4
    ],
    rating: null,
    slope: null,
    tee: "Mens",
  },
];

// ============================================================
// SPECIAL COURSES
//
// Do NOT put facilities with multiple interchangeable nines
// through makeStandardCourse().
//
// Indooroopilly
// Keperra
// Royal Pines
// Sanctuary Cove
// etc.
//
// We can add those separately once each routing is mapped.
// ============================================================

const SPECIAL_COURSES = [];

// ============================================================
// BUILD DATABASE ROWS
// ============================================================

const COURSE_ROWS = [
  ...STANDARD_COURSES.flatMap(makeStandardCourse),
  ...SPECIAL_COURSES,
];

// ============================================================
// VALIDATION
// ============================================================

function validateCourse(course) {
  const holes = Number(course.holes);

  if (holes !== 9 && holes !== 18) {
    throw new Error(
      `${course.name}: holes must be either 9 or 18`
    );
  }

  if (!Array.isArray(course.pars)) {
    throw new Error(
      `${course.name}: pars must be an array`
    );
  }

  if (course.pars.length !== holes) {
    throw new Error(
      `${course.name}: expected ${holes} pars but found ${course.pars.length}`
    );
  }

  course.pars.forEach((par, index) => {
    const value = Number(par);

    if (
      !Number.isInteger(value) ||
      value < 3 ||
      value > 6
    ) {
      throw new Error(
        `${course.name}: invalid par on hole ${index + 1}: ${par}`
      );
    }
  });

  if (
    course.rating !== null &&
    course.rating !== undefined
  ) {
    const rating = Number(course.rating);

    if (
      !Number.isFinite(rating) ||
      rating < 25 ||
      rating > 90
    ) {
      throw new Error(
        `${course.name}: invalid course rating ${course.rating}`
      );
    }
  }

  if (
    course.slope !== null &&
    course.slope !== undefined
  ) {
    const slope = Number(course.slope);

    if (
      !Number.isInteger(slope) ||
      slope < 55 ||
      slope > 155
    ) {
      throw new Error(
        `${course.name}: invalid slope rating ${course.slope}`
      );
    }
  }

  return true;
}

// ============================================================
// SEED FUNCTION
// ============================================================

export async function seedQldScorecards() {
  console.log("");
  console.log("==========================================");
  console.log("🏌️ TeeRadar QLD scorecard seed");
  console.log("==========================================");
  console.log(
    `Courses: ${STANDARD_COURSES.length}`
  );
  console.log(
    `Templates: ${COURSE_ROWS.length}`
  );
  console.log("");

  let processed = 0;
  let failed = 0;

  for (const course of COURSE_ROWS) {
    try {
      validateCourse(course);

      const holes = Number(course.holes);

      const rating =
        course.rating === null ||
        course.rating === undefined
          ? null
          : Number(course.rating);

      const slope =
        course.slope === null ||
        course.slope === undefined
          ? null
          : Number(course.slope);

      const tee =
        course.tee &&
        String(course.tee).trim()
          ? String(course.tee).trim()
          : null;

      await db.query(
        `
          INSERT INTO scorecard_courses (
            name,
            state,
            holes,
            pars_json,
            dists_json,
            course_rating,
            slope_rating,
            tee_colour,
            updated_at
          )

          VALUES (
            $1,
            'QLD',
            $2,
            $3::jsonb,
            '[]'::jsonb,
            $4,
            $5,
            $6,
            now()
          )

          ON CONFLICT (
            name,
            state,
            holes
          )

          DO UPDATE SET

            pars_json =
              EXCLUDED.pars_json,

            course_rating =
              COALESCE(
                EXCLUDED.course_rating,
                scorecard_courses.course_rating
              ),

            slope_rating =
              COALESCE(
                EXCLUDED.slope_rating,
                scorecard_courses.slope_rating
              ),

            tee_colour =
              COALESCE(
                EXCLUDED.tee_colour,
                scorecard_courses.tee_colour
              ),

            updated_at =
              now();
        `,
        [
          course.name,
          holes,
          JSON.stringify(course.pars),
          rating,
          slope,
          tee,
        ]
      );

      processed++;

      console.log(
        `✅ ${course.name} (${holes})`
      );
    } catch (error) {
      failed++;

      console.error(
        `❌ ${course.name}:`,
        error?.message || error
      );
    }
  }

  console.log("");
  console.log("==========================================");
  console.log("QLD SCORECARD SEED COMPLETE");
  console.log("==========================================");
  console.log(`✅ Processed: ${processed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📋 Total: ${COURSE_ROWS.length}`);
  console.log("");

  return {
    ok: failed === 0,
    state: "QLD",
    courses: STANDARD_COURSES.length,
    templates: COURSE_ROWS.length,
    processed,
    failed,
  };
}

export default seedQldScorecards;
