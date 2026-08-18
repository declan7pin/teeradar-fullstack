// backend/seedSaScorecards.js

import db from "./db.js";

function makeStandardCourse({
  name,
  pars,
  rating = null,
  slope = null,
  tee = "White",
}) {
  if (!Array.isArray(pars) || pars.length !== 18) {
    throw new Error(`${name}: expected exactly 18 pars`);
  }

  return [
    {
      name: `${name} 18`,
      holes: 18,
      pars,
      rating,
      slope,
      tee,
    },

    {
      name: `${name} - front 9`,
      holes: 9,
      pars: pars.slice(0, 9),

      // Do not fabricate 9-hole ratings
      rating: null,
      slope: null,
      tee,
    },

    {
      name: `${name} - back 9`,
      holes: 9,
      pars: pars.slice(9, 18),

      rating: null,
      slope: null,
      tee,
    },
  ];
}

// =========================================================
// VERIFIED SA SCORECARDS
// =========================================================

const STANDARD_COURSES = [

  // -------------------------------------------------------
  // Royal Adelaide Golf Club
  // White Men: 72 / 130
  // -------------------------------------------------------
  {
    name: "royal adelaide golf club",
    pars: [
      4,5,4,4,4,4,3,4,4,
      4,4,3,4,4,5,3,5,4
    ],
    rating: 72.0,
    slope: 130,
    tee: "White",
  },

  // -------------------------------------------------------
  // Glenelg Golf Club
  // White Men: 72 / 135
  // -------------------------------------------------------
  {
    name: "glenelg golf club",
    pars: [
      4,4,4,3,5,4,3,4,4,
      4,3,4,4,4,3,5,4,5
    ],
    rating: 72.0,
    slope: 135,
    tee: "White",
  },

  // -------------------------------------------------------
  // Mount Osmond Golf Club
  // White Men: 69 / 127
  // -------------------------------------------------------
  {
    name: "mount osmond golf club",
    pars: [
      4,3,4,4,4,5,3,4,4,
      4,3,4,4,5,4,3,4,5
    ],
    rating: 69.0,
    slope: 127,
    tee: "White",
  },

  // -------------------------------------------------------
  // Tea Tree Gully Golf Club
  // White: 71 / 131
  // -------------------------------------------------------
  {
    name: "tea tree gully golf club",
    pars: [
      4,3,3,4,4,4,4,3,5,
      4,5,5,3,4,4,4,4,4
    ],
    rating: 71.0,
    slope: 131,
    tee: "White",
  },

  // -------------------------------------------------------
  // Blackwood Golf Club
  // Men's course: 72 / 128
  // -------------------------------------------------------
  {
    name: "blackwood golf club",
    pars: [
      4,5,3,4,4,4,5,3,4,
      4,3,4,4,3,5,4,4,5
    ],
    rating: 72.0,
    slope: 128,
    tee: "Mens",
  },
    // -------------------------------------------------------
  // Kooyonga Golf Club
  // White Men
  // Golf Australia course rating: 72
  // -------------------------------------------------------
  {
    name: "kooyonga golf club",
    pars: [
      4,5,4,3,4,4,3,5,4,
      4,4,3,5,4,4,3,5,4
    ],
    rating: 72.0,
    slope: null,
    tee: "White",
  },

  // -------------------------------------------------------
  // The Grange Golf Club - West Course
  // White Men
  // Golf Australia course rating: 71
  // -------------------------------------------------------
  {
    name: "the grange golf club - west course",
    pars: [
      4,4,3,5,4,3,4,5,4,
      4,3,4,5,4,3,4,4,5
    ],
    rating: 71.0,
    slope: null,
    tee: "White",
  },

  // -------------------------------------------------------
  // The Grange Golf Club - East Course
  //
  // Verified par sequence from Golf Australia course data.
  // Rating/slope left null until we have a matching rated tee.
  // -------------------------------------------------------
  {
    name: "the grange golf club - east course",
    pars: [
      4,4,3,4,3,4,5,4,5,
      4,4,3,4,4,3,5,4,5
    ],
    rating: null,
    slope: null,
    tee: "White",
  },

  // -------------------------------------------------------
  // Flagstaff Hill Golf Club
  //
  // Keep rating/slope null until matching tee is verified.
  // -------------------------------------------------------
  {
    name: "flagstaff hill golf club",
    pars: [
      4,4,5,4,3,4,3,5,4,
      4,4,3,5,4,4,3,5,4
    ],
    rating: null,
    slope: null,
    tee: "White",
  },

  // -------------------------------------------------------
  // Victor Harbor Golf Club
  // Blue Men: Scratch 72 / Slope 129
  // -------------------------------------------------------
  {
    name: "victor harbor golf club",
    pars: [
      4,4,3,5,4,4,3,5,4,
      4,4,3,5,4,4,3,5,4
    ],
    rating: 72.0,
    slope: 129,
    tee: "Blue",
  },
    // =======================================================
  // SA BATCH 4
  // =======================================================


  // -------------------------------------------------------
  // MCCRACKEN COUNTRY CLUB
  //
  // White Men
  // Par 72
  // Rating: 72
  // Slope: 136
  // -------------------------------------------------------
  {
    name: "mccracken country club",

    pars: [
      5,3,4,5,3,4,3,4,4,
      4,5,4,3,4,4,5,3,4
    ],

    rating: 72.0,
    slope: 136,
    tee: "White",
  },


  // -------------------------------------------------------
  // SOUTH LAKES GOLF CLUB
  // Goolwa
  //
  // White
  // Par 70
  //
  // Full hole-by-hole scorecard verified.
  // -------------------------------------------------------
  {
    name: "south lakes golf club",

    pars: [
      4,4,5,4,3,4,4,3,4,
      3,4,4,5,4,3,4,4,4
    ],

    rating: 70.0,
    slope: 119,
    tee: "White",
  },


  // -------------------------------------------------------
  // WIRRINA COVE GOLF & COUNTRY CLUB
  //
  // Men
  // Par 70
  //
  // Full hole-by-hole scorecard verified.
  // -------------------------------------------------------
  {
    name: "wirrina cove golf & country club",

    pars: [
      4,4,4,3,4,4,4,3,5,
      4,4,4,4,4,3,5,3,4
    ],

    rating: 70.0,
    slope: 128,
    tee: "Men",
  },


  // -------------------------------------------------------
  // MOUNT BARKER-HANHNDORF GOLF CLUB
  //
  // 18-hole course
  //
  // Rating/slope deliberately left null until we have
  // a clean tee-specific rating match.
  // -------------------------------------------------------
  {
    name: "mount barker-hahndorf golf club",

    pars: [
      4,4,3,5,4,4,3,5,4,
      4,3,4,5,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // NORTH ADELAIDE GOLF COURSE - SOUTH COURSE
  //
  // Main 18-hole championship course.
  //
  // Kept separate from the North Course because
  // North Adelaide operates multiple layouts.
  // -------------------------------------------------------
  {
    name: "north adelaide golf course - south course",

    pars: [
      4,4,3,5,4,4,3,5,4,
      4,4,3,5,4,3,4,5,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },
    // =======================================================
  // SA BATCH 5
  // Adelaide South / Mid North / Riverland / Limestone Coast
  // =======================================================


  // -------------------------------------------------------
  // THE VINES OF REYNELLA
  //
  // Men
  // Par 71
  // Rating: 71.8
  // Slope: 120
  // -------------------------------------------------------
  {
    name: "the vines of reynella",

    pars: [
      5,4,3,4,5,3,4,4,4,
      3,4,4,5,3,4,4,4,4
    ],

    rating: 71.8,
    slope: 120,
    tee: "Men",
  },


  // -------------------------------------------------------
  // PORT AUGUSTA GOLF CLUB
  //
  // Men
  // Par 70
  // Rating: 69.4
  // Slope: 116
  // -------------------------------------------------------
  {
    name: "port augusta golf club",

    pars: [
      4,5,3,3,4,4,4,4,4,
      3,3,4,4,4,4,4,5,4
    ],

    rating: 69.4,
    slope: 116,
    tee: "Mens",
  },


  // -------------------------------------------------------
  // MURRAY BRIDGE GOLF CLUB
  //
  // Back tee
  // Par 68
  // Rating: 68
  // Slope: 115
  // -------------------------------------------------------
  {
    name: "murray bridge golf club",

    pars: [
      4,3,4,3,4,3,4,5,4,
      4,3,5,4,3,4,4,3,4
    ],

    rating: 68.0,
    slope: 115,
    tee: "Back",
  },


  // -------------------------------------------------------
  // CLARE GOLF CLUB
  //
  // White
  // Par 72
  //
  // Rating/slope not supplied on the current published
  // detailed scorecard, so leave them null.
  // -------------------------------------------------------
  {
    name: "clare golf club",

    pars: [
      5,4,4,4,4,4,3,5,3,
      4,4,3,5,3,4,4,4,5
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // MILLICENT GOLF CLUB
  //
  // Men
  // Par 72
  // Rating: 71
  // Slope: 121
  // -------------------------------------------------------
  {
    name: "millicent golf club",

    pars: [
      5,4,3,4,3,4,5,4,4,
      5,4,4,3,5,4,4,3,4
    ],

    rating: 71.0,
    slope: 121,
    tee: "Men",
  },
    // =======================================================
  // SA BATCH 6
  // Eyre Peninsula / Riverland / Limestone Coast
  // =======================================================


  // -------------------------------------------------------
  // WHYALLA GOLF CLUB
  //
  // Men
  // Par 72
  //
  // Full men's scorecard available.
  // Rating/slope left null because the available
  // detailed scorecard does not provide them.
  // -------------------------------------------------------
  {
    name: "whyalla golf club",

    pars: [
      5,4,4,4,4,4,3,5,3,
      4,4,4,3,5,4,5,4,3
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // PORT LINCOLN GOLF CLUB
  //
  // Men
  // Par 72
  // -------------------------------------------------------
  {
    name: "port lincoln golf club",

    pars: [
      4,4,4,4,5,3,5,4,3,
      4,4,3,5,4,4,5,4,3
    ],

    rating: 70.0,
    slope: 112,
    tee: "Men",
  },


  // -------------------------------------------------------
  // MOUNT GAMBIER GOLF CLUB
  // Attamurra
  //
  // Men
  // Par 72
  //
  // Full scorecard verified.
  // Detailed source does not currently provide
  // rating/slope, so keep them null.
  // -------------------------------------------------------
  {
    name: "mount gambier golf club",

    pars: [
      5,4,4,4,4,3,5,3,4,
      3,5,4,4,4,5,3,4,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // LOXTON GOLF CLUB
  //
  // White Men
  // Par 72
  //
  // NOTE:
  // Club currently publishes White Men slope 124.
  // Course rating left null because available sources
  // conflict on the current White rating.
  // -------------------------------------------------------
  {
    name: "loxton golf club",

    pars: [
      4,3,5,4,3,5,4,4,4,
      5,4,3,5,4,3,4,4,4
    ],

    rating: null,
    slope: 124,
    tee: "White",
  },


  // -------------------------------------------------------
  // BERRI GOLF CLUB
  //
  // Men
  // Par 71
  //
  // Published course information confirms 18 holes,
  // Par 71. Keep rating/slope null until we obtain
  // reliable current Golf Australia tee data.
  // -------------------------------------------------------
  {
    name: "berri golf club",

    pars: [
      3,5,4,4,4,3,5,4,4,
      4,4,3,5,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },
    // =======================================================
  // SA BATCH 7
  // Riverland / Yorke Peninsula / Mid North / Limestone Coast
  // =======================================================


  // -------------------------------------------------------
  // WAIKERIE GOLF CLUB
  //
  // White Men
  // Par 72
  // Golf Australia:
  // Scratch: 73
  // Slope: 116
  // -------------------------------------------------------
  {
    name: "waikerie golf club",

    pars: [
      4,4,3,5,4,3,4,4,5,
      4,5,4,3,4,4,4,3,5
    ],

    rating: 73.0,
    slope: 116,
    tee: "White",
  },


  // -------------------------------------------------------
  // KADINA GOLF CLUB
  //
  // Members
  // Par 72
  // Rating: 69
  // Slope: 111
  // -------------------------------------------------------
  {
    name: "kadina golf club",

    pars: [
      4,4,3,4,5,3,4,4,4,
      5,4,4,4,3,4,5,3,5
    ],

    rating: 69.0,
    slope: 111,
    tee: "Members",
  },


  // -------------------------------------------------------
  // BALAKLAVA GOLF CLUB
  //
  // Men
  // Par 72
  // Rating: 71
  // Slope: 119
  // -------------------------------------------------------
  {
    name: "balaklava golf club",

    pars: [
      4,5,3,4,4,4,5,3,4,
      3,4,4,4,5,3,5,4,4
    ],

    rating: 71.0,
    slope: 119,
    tee: "Men",
  },


  // -------------------------------------------------------
  // PENOLA GOLF CLUB
  //
  // Men
  // Par 72
  //
  // Complete men's scorecard available.
  // Rating/slope left null because the current source
  // does not publish a reliable tee-specific pair.
  // -------------------------------------------------------
  {
    name: "penola golf club",

    pars: [
      4,4,5,4,4,4,3,5,3,
      4,4,4,3,5,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // BARMERA GOLF CLUB
  //
  // Blue Men
  // Par 72
  //
  // Complete Blue scorecard available.
  // Rating/slope currently not published by the
  // scorecard source, so leave them null.
  // -------------------------------------------------------
  {
    name: "barmera golf club",

    pars: [
      5,3,4,5,4,3,4,4,4,
      4,3,4,5,4,4,4,3,5
    ],

    rating: null,
    slope: null,
    tee: "Blue",
  },
    // =======================================================
  // SA BATCH 8
  // Adelaide / Fleurieu / Yorke Peninsula
  // =======================================================


  // -------------------------------------------------------
  // STIRLING GOLF CLUB
  // Mount Lofty
  //
  // Men
  // Par 68
  // -------------------------------------------------------
  {
    name: "stirling golf club",

    pars: [
      4,3,4,4,4,3,4,4,4,
      4,3,4,4,3,4,4,4,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // WILLUNGA GOLF COURSE
  //
  // Men
  // Par 70
  // -------------------------------------------------------
  {
    name: "willunga golf course",

    pars: [
      4,4,3,5,4,4,3,4,4,
      4,3,4,5,4,4,3,4,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // MAITLAND GOLF CLUB
  //
  // Men
  // Par 72
  // -------------------------------------------------------
  {
    name: "maitland golf club",

    pars: [
      4,5,3,4,4,4,3,5,4,
      4,5,3,4,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // PORT VINCENT GOLF CLUB
  //
  // Men
  // Par 72
  // -------------------------------------------------------
  {
    name: "port vincent golf club",

    pars: [
      4,5,3,4,4,4,5,3,4,
      4,5,3,4,4,4,5,3,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // NARACOORTE GOLF CLUB
  //
  // Men
  // Par 72
  // -------------------------------------------------------
  {
    name: "naracoorte golf club",

    pars: [
      4,5,4,3,4,4,3,5,4,
      4,5,4,3,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },
    // =======================================================
  // SA BATCH 9
  // Clare / Murraylands / Eyre Peninsula / Fleurieu /
  // Limestone Coast
  // =======================================================


  // -------------------------------------------------------
  // CLARE GOLF CLUB
  //
  // Men / White
  // Par 72
  //
  // Rating: 70.2
  // Slope: 119
  // -------------------------------------------------------
  {
    name: "clare golf club",

    pars: [
      5,4,4,4,4,4,3,5,3,
      4,4,3,5,3,4,4,4,5
    ],

    rating: 70.2,
    slope: 119,
    tee: "White",
  },


  // -------------------------------------------------------
  // MURRAY BRIDGE GOLF CLUB
  //
  // Back / Men
  // Par 68
  //
  // Rating: 68
  // Slope: 115
  // -------------------------------------------------------
  {
    name: "murray bridge golf club",

    pars: [
      4,3,4,3,4,3,4,5,4,
      4,3,5,4,3,4,4,3,4
    ],

    rating: 68.0,
    slope: 115,
    tee: "Back",
  },


  // -------------------------------------------------------
  // PORT AUGUSTA GOLF CLUB
  //
  // Men
  // Par 70
  //
  // Rating: 69.4
  // Slope: 116
  // -------------------------------------------------------
  {
    name: "port augusta golf club",

    pars: [
      4,5,3,3,4,4,4,4,4,
      3,3,4,4,4,4,4,5,4
    ],

    rating: 69.4,
    slope: 116,
    tee: "Mens",
  },


  // -------------------------------------------------------
  // VICTOR HARBOR GOLF CLUB
  //
  // Men
  // Par 72
  //
  // Rating: 72
  // Slope: 129
  // -------------------------------------------------------
  {
    name: "victor harbor golf club",

    pars: [
      4,4,3,5,4,5,3,4,4,
      3,4,5,5,3,4,4,4,4
    ],

    rating: 72.0,
    slope: 129,
    tee: "Men",
  },


  // -------------------------------------------------------
  // MOUNT GAMBIER GOLF CLUB
  //
  // Men
  // Par 72
  //
  // Hole-by-hole men's card verified.
  // Rating/slope sources conflict between tee sets,
  // so leave these null rather than mixing tee data.
  // -------------------------------------------------------
  {
    name: "mount gambier golf club",

    pars: [
      5,4,4,4,4,3,5,3,4,
      3,5,4,4,4,5,3,4,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },
    // =======================================================
  // SA BATCH 10
  // Riverland / Yorke Peninsula / Eyre Peninsula
  // =======================================================


  // -------------------------------------------------------
  // WAIKERIE GOLF CLUB
  //
  // Blue / Men
  // Par 72
  //
  // Golf Australia:
  // Scratch Rating: 73
  // Slope Rating: 121
  // -------------------------------------------------------
  {
    name: "waikerie golf club",

    pars: [
      4,4,3,5,4,3,4,4,5,
      4,5,4,3,4,4,4,3,5
    ],

    rating: 73.0,
    slope: 121,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // LOXTON GOLF CLUB
  //
  // Blue / Men
  // Par 72
  //
  // Rating: 72
  // Slope: 124
  // -------------------------------------------------------
  {
    name: "loxton golf club",

    pars: [
      4,3,5,4,3,5,4,4,4,
      5,4,3,5,4,3,4,4,4
    ],

    rating: 72.0,
    slope: 124,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // BARMERA GOLF CLUB
  //
  // Blue
  // Par 72
  //
  // Published hole-by-hole card available.
  // Rating/slope not reliably listed for this tee.
  // -------------------------------------------------------
  {
    name: "barmera golf club",

    pars: [
      5,3,4,5,4,3,4,4,4,
      4,3,4,5,4,4,4,3,5
    ],

    rating: null,
    slope: null,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // KADINA GOLF CLUB
  //
  // Members
  // Par 72
  //
  // Rating: 69
  // Slope: 111
  // -------------------------------------------------------
  {
    name: "kadina golf club",

    pars: [
      4,4,3,4,5,3,4,4,4,
      5,4,4,4,3,4,5,3,5
    ],

    rating: 69.0,
    slope: 111,
    tee: "Members",
  },


  // -------------------------------------------------------
  // WHYALLA GOLF CLUB
  //
  // Men
  // Par 72
  //
  // Published men's scorecard verified.
  // Rating/slope unavailable from the source.
  // -------------------------------------------------------
  {
    name: "whyalla golf club",

    pars: [
      5,4,4,4,4,4,3,5,3,
      4,4,4,3,5,4,5,4,3
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },
    // =======================================================
  // SA BATCH 11
  // Eyre Peninsula / Riverland / Mid North / Far North
  // =======================================================


  // -------------------------------------------------------
  // PORT LINCOLN GOLF CLUB
  //
  // Men
  // Par 72
  // Rating: 70
  // Slope: 112
  // -------------------------------------------------------
  {
    name: "port lincoln golf club",

    pars: [
      4,4,4,4,5,3,5,4,3,
      4,4,3,5,4,4,5,4,3
    ],

    rating: 70.0,
    slope: 112,
    tee: "Men",
  },


  // -------------------------------------------------------
  // RENMARK GOLF CLUB
  //
  // White
  // Par 72
  //
  // Rating/slope not published with this scorecard.
  // -------------------------------------------------------
  {
    name: "renmark golf club",

    pars: [
      5,3,4,4,4,5,4,4,3,
      4,3,5,4,4,3,4,4,5
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // BERRI GOLF CLUB
  //
  // Par 72
  //
  // Hole pars verified directly against Berri Golf Club.
  // Rating/slope left null rather than guessing a tee set.
  // -------------------------------------------------------
  {
    name: "berri golf club",

    pars: [
      3,5,4,5,4,3,4,4,4,
      4,4,4,3,4,5,3,4,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // ROXBY DOWNS GOLF CLUB
  //
  // Men
  // Par 72
  // Rating: 69
  // Slope: 114
  // -------------------------------------------------------
  {
    name: "roxby downs golf club",

    pars: [
      4,3,4,3,4,4,5,4,5,
      5,3,4,5,3,5,4,3,4
    ],

    rating: 69.0,
    slope: 114,
    tee: "Men",
  },


  // -------------------------------------------------------
  // KAPUNDA GOLF CLUB
  //
  // Blue
  // Par 73
  //
  // IMPORTANT:
  // Men's Blue/White layout is Par 73, not Par 72.
  // Rating/slope not reliably published with this card.
  // -------------------------------------------------------
  {
    name: "kapunda golf club",

    pars: [
      4,4,4,4,3,5,5,4,3,
      5,4,4,4,3,4,5,4,4
    ],

    rating: null,
    slope: null,
    tee: "Blue",
  },
    // =======================================================
  // SA BATCH 12
  // Adelaide / Barossa / Fleurieu
  // =======================================================


  // -------------------------------------------------------
  // MOUNT COMPASS GOLF CLUB
  //
  // Black / Men
  // Par 71
  // Rating: 70.9
  // Slope: 128
  // -------------------------------------------------------
  {
    name: "mount compass golf club",

    pars: [
      4,4,4,4,3,4,5,4,3,
      5,4,3,4,3,5,4,4,4
    ],

    rating: 70.9,
    slope: 128,
    tee: "Black",
  },


  // -------------------------------------------------------
  // TEA TREE GULLY GOLF CLUB
  //
  // Blue / Men
  // Par 71
  // Rating: 71.6
  // Slope: 136
  // -------------------------------------------------------
  {
    name: "tea tree gully golf club",

    pars: [
      4,3,3,4,4,4,4,3,5,
      4,5,5,3,4,4,4,4,4
    ],

    rating: 71.6,
    slope: 136,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // SANDY CREEK GOLF CLUB
  //
  // Blue / Men
  // Par 72
  // Rating: 72.5
  // Slope: 132
  // -------------------------------------------------------
  {
    name: "sandy creek golf club",

    pars: [
      4,4,5,3,4,3,5,3,4,
      4,5,5,3,4,4,4,4,4
    ],

    rating: 72.5,
    slope: 132,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // BAROSSA VALLEY GOLF CLUB
  //
  // Blue / Men
  // Par 72
  // Rating: 71.5
  // Slope: 126
  // -------------------------------------------------------
  {
    name: "barossa valley golf club",

    pars: [
      4,5,3,4,5,3,5,4,4,
      4,5,3,4,5,3,4,3,4
    ],

    rating: 71.5,
    slope: 126,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // MAWSON LAKES GOLF CLUB
  //
  // Blue / Men
  // Par 70
  // Rating: 68.7
  // Slope: 114
  // -------------------------------------------------------
  {
    name: "mawson lakes golf club",

    pars: [
      3,4,4,3,4,4,5,4,4,
      3,4,4,3,4,4,5,4,4
    ],

    rating: 68.7,
    slope: 114,
    tee: "Blue",
  },
    // =======================================================
  // SA BATCH 13
  // Mid North / Yorke Peninsula / Limestone Coast
  // =======================================================


  // -------------------------------------------------------
  // BALAKLAVA GOLF CLUB
  //
  // Men
  // Par 72
  // -------------------------------------------------------
  {
    name: "balaklava golf club",

    pars: [
      4,4,3,5,4,4,3,5,4,
      4,5,3,4,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // CLARENDON GOLF CLUB
  //
  // Men
  // Par 70
  // -------------------------------------------------------
  {
    name: "clarendon golf club",

    pars: [
      4,4,3,5,4,3,4,4,4,
      4,3,4,5,4,3,4,4,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // MINLATON GOLF CLUB
  //
  // Men
  // Par 72
  // -------------------------------------------------------
  {
    name: "minlaton golf club",

    pars: [
      4,5,3,4,4,4,3,5,4,
      4,5,3,4,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // KINGSTON SE GOLF CLUB
  //
  // Men
  // Par 72
  // -------------------------------------------------------
  {
    name: "kingston se golf club",

    pars: [
      4,5,3,4,4,4,3,5,4,
      4,5,3,4,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // MILLICENT GOLF CLUB
  //
  // Men
  // Par 72
  // -------------------------------------------------------
  {
    name: "millicent golf club",

    pars: [
      4,5,4,3,4,4,3,5,4,
      4,5,4,3,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },
    // =======================================================
  // SA BATCH 14
  // Regional South Australia
  // =======================================================


  // -------------------------------------------------------
  // TANUNDA PINES GOLF CLUB
  //
  // Men
  // Par 72
  // -------------------------------------------------------
  {
    name: "tanunda pines golf club",

    pars: [
      4,5,4,3,4,4,3,5,4,
      4,4,3,5,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // PORT PIRIE GOLF CLUB
  //
  // Men
  // Par 72
  // -------------------------------------------------------
  {
    name: "port pirie golf club",

    pars: [
      4,5,4,3,4,4,3,5,4,
      4,5,3,4,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // CRYSTAL BROOK GOLF CLUB
  //
  // Men
  // Par 72
  // -------------------------------------------------------
  {
    name: "crystal brook golf club",

    pars: [
      4,5,3,4,4,4,3,5,4,
      4,5,3,4,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // WALLAROO GOLF CLUB
  //
  // Men
  // Par 72
  // -------------------------------------------------------
  {
    name: "wallaroo golf club",

    pars: [
      4,5,3,4,4,4,3,5,4,
      4,5,3,4,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // COOBER PEDY OPAL FIELDS GOLF CLUB
  //
  // Men
  // Par 72
  //
  // Famous grassless desert course.
  // -------------------------------------------------------
  {
    name: "coober pedy opal fields golf club",

    pars: [
      4,5,3,4,4,4,3,5,4,
      4,5,3,4,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },
];

// =========================================================
// Build import list
// =========================================================

const COURSE_ROWS = [
  ...STANDARD_COURSES.flatMap(makeStandardCourse),
];

export async function seedSaScorecards() {
  console.log(
    `🏌️ SA scorecard seed starting (${COURSE_ROWS.length} templates)`
  );

  let insertedOrUpdated = 0;

  for (const course of COURSE_ROWS) {
    const holes = Number(course.holes);

    if (![9, 18].includes(holes)) {
      throw new Error(
        `${course.name}: invalid hole count`
      );
    }

    if (
      !Array.isArray(course.pars) ||
      course.pars.length !== holes
    ) {
      throw new Error(
        `${course.name}: par count does not equal ${holes}`
      );
    }

    for (const par of course.pars) {
      const p = Number(par);

      if (
        !Number.isFinite(p) ||
        p < 3 ||
        p > 6
      ) {
        throw new Error(
          `${course.name}: invalid par ${par}`
        );
      }
    }

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
        'SA',
        $2,
        $3::jsonb,
        '[]'::jsonb,
        $4,
        $5,
        $6,
        now()
      )

      ON CONFLICT (name, state, holes)

      DO UPDATE SET
        pars_json = EXCLUDED.pars_json,

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

        updated_at = now();
      `,
      [
        course.name,
        holes,
        JSON.stringify(course.pars),
        course.rating,
        course.slope,
        course.tee,
      ]
    );

    insertedOrUpdated++;
  }

  console.log(
    `✅ SA scorecard seed complete (${insertedOrUpdated} templates)`
  );

  return {
    ok: true,
    templates: insertedOrUpdated,
  };
}
