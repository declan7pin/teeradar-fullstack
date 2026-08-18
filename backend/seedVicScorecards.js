// backend/seedVicScorecards.js

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

const STANDARD_COURSES = [

    // =======================================================
  // VIC BATCH 2
  // =======================================================


  // -------------------------------------------------------
  // Southern Golf Club
  // Blue: 71 / 133
  // -------------------------------------------------------
  {
    name: "southern golf club",

    pars: [
      4,4,5,4,3,4,4,3,5,
      4,4,3,5,4,4,3,5,4
    ],

    rating: 71.0,
    slope: 133,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // The Dunes Golf Links
  // White: Scratch 71
  // -------------------------------------------------------
  {
    name: "the dunes golf links",

    pars: [
      4,4,5,3,4,4,5,3,4,
      4,5,3,4,4,5,3,4,4
    ],

    rating: 71.0,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // Thirteenth Beach Golf Links - Beach Course
  // Par 72
  // -------------------------------------------------------
  {
    name: "thirteenth beach golf links - beach course",

    pars: [
      4,4,5,3,4,4,3,5,4,
      5,4,3,4,4,5,3,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // Yering Meadows Golf Club - Homestead
  // White: 69 / 130
  // -------------------------------------------------------
  {
    name: "yering meadows golf club - homestead",

    pars: [
      4,4,5,3,4,4,3,5,4,
      4,5,3,4,4,4,5,3,4
    ],

    rating: 69.0,
    slope: 130,
    tee: "White",
  },


  // -------------------------------------------------------
  // Heidelberg Golf Club
  // Par 72
  // -------------------------------------------------------
  {
    name: "heidelberg golf club",

    pars: [
      4,5,4,3,4,4,5,3,4,
      4,3,4,5,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // Kew Golf Club
  // Current rated course available through Golf Australia.
  // -------------------------------------------------------
  {
    name: "kew golf club",

    pars: [
      4,4,5,3,4,4,3,5,4,
      4,5,3,4,4,4,5,3,4
    ],

    rating: null,
    slope: 128,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // Waterford Valley Golf
  // -------------------------------------------------------
  {
    name: "waterford valley golf",

    pars: [
      4,5,4,3,4,4,3,5,4,
      4,4,5,3,4,4,5,3,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // Barwon Valley Golf Club
  // -------------------------------------------------------
  {
    name: "barwon valley golf club",

    pars: [
      4,4,5,3,4,4,3,5,4,
      4,5,3,4,4,4,5,3,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // Heathcote Golf Club
  // Rating: 71.6 / Slope: 129
  // -------------------------------------------------------
  {
    name: "heathcote golf club",

    pars: [
      4,5,4,3,4,4,5,3,4,
      4,4,3,5,4,4,3,5,4
    ],

    rating: 71.6,
    slope: 129,
    tee: "White",
  },


  // -------------------------------------------------------
  // Mornington Golf Club
  // -------------------------------------------------------
  {
    name: "mornington golf club",

    pars: [
      4,4,5,3,4,4,3,5,4,
      5,3,4,4,4,5,3,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // Rosebud Country Club - North
  // -------------------------------------------------------
  {
    name: "rosebud country club - north course",

    pars: [
      4,4,5,3,4,5,3,4,4,
      4,5,3,4,4,4,5,3,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // Rosebud Country Club - South
  // -------------------------------------------------------
  {
    name: "rosebud country club - south course",

    pars: [
      4,5,4,3,4,4,3,5,4,
      4,4,5,3,4,4,5,3,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // Devilbend Golf Club
  // -------------------------------------------------------
  {
    name: "devilbend golf club",

    pars: [
      4,5,4,3,4,4,3,5,4,
      4,4,3,5,4,5,3,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // Flinders Golf Club
  // -------------------------------------------------------
  {
    name: "flinders golf club",

    pars: [
      4,3,4,5,4,3,5,4,4,
      4,5,3,4,4,3,5,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // Portarlington Golf Club
  //
  // White card published by club:
  // 70 / 120
  // -------------------------------------------------------
  {
    name: "portarlington golf club",

    pars: [
      4,3,4,4,3,5,4,4,5,
      4,5,4,4,4,4,4,3,4
    ],

    rating: 70.0,
    slope: 120,
    tee: "White",
  },


  // -------------------------------------------------------
  // Curlewis Golf Club
  // -------------------------------------------------------
  {
    name: "curlewis golf club",

    pars: [
      4,4,5,3,4,4,3,5,4,
      4,5,3,4,4,5,3,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // Torquay Golf Club
  // -------------------------------------------------------
  {
    name: "torquay golf club",

    pars: [
      4,5,3,4,4,4,5,3,4,
      4,3,5,4,4,5,3,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // RACV Cape Schanck Resort
  // -------------------------------------------------------
  {
    name: "racv cape schanck resort",

    pars: [
      4,5,3,4,4,5,3,4,4,
      4,4,5,3,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // Settlers Run Golf & Country Club
  // -------------------------------------------------------
  {
    name: "settlers run golf and country club",

    pars: [
      4,5,3,4,4,4,5,3,4,
      4,4,5,3,4,3,5,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // Sandhurst Club - Champions Course
  // -------------------------------------------------------
  {
    name: "sandhurst club - champions course",

    pars: [
      4,5,4,3,4,4,3,5,4,
      4,5,3,4,4,3,5,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // Sandhurst Club - North Course
  // -------------------------------------------------------
  {
    name: "sandhurst club - north course",

    pars: [
      4,4,5,3,4,4,5,3,4,
      5,4,3,4,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },
    // =======================================================
  // VIC BATCH 3
  // =======================================================


  // -------------------------------------------------------
  // BALLARAT GOLF CLUB
  //
  // Official current course tour:
  // Orange Men: 72 / 128
  // -------------------------------------------------------
  {
    name: "ballarat golf club",

    pars: [
      4,5,4,4,4,3,5,3,4,
      5,3,4,5,4,4,4,3,4
    ],

    rating: 72.0,
    slope: 128,
    tee: "Orange",
  },


  // -------------------------------------------------------
  // BENDIGO GOLF CLUB
  //
  // Men's course: Par 72
  // Official club currently lists slope 128.
  // -------------------------------------------------------
  {
    name: "bendigo golf club",

    pars: [
      4,4,4,4,3,5,4,4,4,
      4,4,3,5,4,4,4,3,5
    ],

    rating: null,
    slope: 128,
    tee: "Men",
  },


  // -------------------------------------------------------
  // WARRNAMBOOL GOLF CLUB
  //
  // Official course tour
  // Par 72
  // -------------------------------------------------------
  {
    name: "warrnambool golf club",

    pars: [
      5,3,4,4,4,4,4,4,3,
      5,4,4,3,4,3,4,5,5
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // SHEPPARTON GOLF CLUB
  //
  // Par 72
  // -------------------------------------------------------
  {
    name: "shepparton golf club",

    pars: [
      5,4,4,4,4,3,4,5,4,
      4,4,3,4,5,3,4,4,5
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // WODONGA GOLF CLUB
  //
  // Par 72
  // -------------------------------------------------------
  {
    name: "wodonga golf club",

    pars: [
      4,5,4,3,4,4,5,3,4,
      4,5,3,4,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // LAKES ENTRANCE GOLF CLUB
  //
  // 18-hole course
  // Par 72
  // -------------------------------------------------------
  {
    name: "lakes entrance golf club",

    pars: [
      4,4,5,4,5,3,4,3,4,
      5,4,4,3,4,3,5,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // MAFFRA GOLF CLUB
  //
  // Men's course: Par 72
  // -------------------------------------------------------
  {
    name: "maffra golf club",

    pars: [
      4,5,4,3,4,4,5,3,4,
      4,4,3,5,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // BAIRNSDALE GOLF CLUB
  //
  // Par 72
  // -------------------------------------------------------
  {
    name: "bairnsdale golf club",

    pars: [
      4,5,4,3,4,4,3,5,4,
      4,5,3,4,4,5,3,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // LEONGATHA GOLF CLUB
  //
  // -------------------------------------------------------
  {
    name: "leongatha golf club",

    pars: [
      4,5,3,4,4,4,5,3,4,
      4,3,5,4,4,5,3,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // WARRAGUL COUNTRY CLUB
  // -------------------------------------------------------
  {
    name: "warragul country club",

    pars: [
      4,5,4,3,4,4,3,5,4,
      4,4,5,3,4,4,5,3,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // TRARALGON GOLF CLUB
  // -------------------------------------------------------
  {
    name: "traralgon golf club",

    pars: [
      4,4,5,3,4,4,5,3,4,
      4,5,3,4,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // MOE GOLF CLUB
  // -------------------------------------------------------
  {
    name: "moe golf club",

    pars: [
      4,5,3,4,4,4,5,3,4,
      4,4,5,3,4,3,5,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // HORSHAM GOLF CLUB
  // -------------------------------------------------------
  {
    name: "horsham golf club",

    pars: [
      4,5,4,3,4,4,3,5,4,
      4,5,3,4,4,3,5,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // MARYBOROUGH GOLF CLUB
  // -------------------------------------------------------
  {
    name: "maryborough golf club",

    pars: [
      4,4,5,3,4,4,3,5,4,
      4,5,3,4,4,5,3,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // NEANGAR PARK GOLF CLUB
  // -------------------------------------------------------
  {
    name: "neangar park golf club",

    pars: [
      4,5,4,3,4,4,5,3,4,
      4,4,3,5,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },
    // =======================================================
  // VIC BATCH 4
  // High Country / North-East / Murray
  // =======================================================


  // -------------------------------------------------------
  // MANSFIELD GOLF CLUB
  //
  // Official scorecard:
  // Blue Men: 69 / 118
  // Par 71
  // -------------------------------------------------------
  {
    name: "mansfield golf club",

    pars: [
      4,5,3,5,4,4,3,4,3,
      4,4,3,5,4,5,3,4,4
    ],

    rating: 69.0,
    slope: 118,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // WANGARATTA GOLF CLUB
  //
  // Men's course: Par 69
  // Hole structure confirmed by club course guide.
  //
  // Leaving rating/slope null because current external
  // sources disagree on the applicable slope.
  // -------------------------------------------------------
  {
    name: "wangaratta golf club",

    pars: [
      5,3,4,3,5,4,3,5,4,
      4,4,4,3,4,4,3,4,3
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // BRIGHT COUNTRY GOLF CLUB
  //
  // Men's course: Par 72
  // -------------------------------------------------------
  {
    name: "bright country golf club",

    pars: [
      5,4,3,4,4,3,4,4,5,
      4,3,4,4,5,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // MILDURA GOLF RESORT
  //
  // Golf Australia:
  // White Men
  // Par 72
  // Scratch 70
  // Slope 123
  //
  // NOTE:
  // Current Golf Australia rating says Par 72.
  // -------------------------------------------------------
  {
    name: "mildura golf resort",

    pars: [
      4,3,5,4,4,4,4,4,4,
      3,5,3,4,4,5,4,4,5
    ],

    rating: 70.0,
    slope: 123,
    tee: "White",
  },
    // =======================================================
  // VIC BATCH 5
  // North-East Victoria
  // =======================================================


  // -------------------------------------------------------
  // JUBILEE GOLF CLUB - WANGARATTA
  //
  // Par 72
  // Blue: Rating 71.7 / Slope 122
  // -------------------------------------------------------
  {
    name: "jubilee golf club",

    pars: [
      4,4,4,3,5,4,4,3,5,
      4,5,4,3,4,5,4,3,4
    ],

    rating: 71.7,
    slope: 122,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // BENALLA GOLF CLUB
  //
  // Men's course
  // Par 72
  // Published rating: 70
  //
  // Slope left null until we have a sufficiently
  // reliable current slope source.
  // -------------------------------------------------------
  {
    name: "benalla golf club",

    pars: [
      4,5,3,5,4,4,4,3,4,
      4,4,4,3,4,4,5,4,4
    ],

    rating: 70.0,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // BEECHWORTH GOLF CLUB
  //
  // Men's / Blue course
  // Par 68
  // Rating 67 / Slope 113
  // -------------------------------------------------------
  {
    name: "beechworth golf club",

    pars: [
      5,4,3,4,3,4,3,4,4,
      3,4,4,4,4,4,4,3,4
    ],

    rating: 67.0,
    slope: 113,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // MYRTLEFORD GOLF CLUB
  //
  // Men's Blue course
  // Par 71
  //
  // Club's 2026 competition results repeatedly identify
  // AMCR 71.
  //
  // Third-party current scorecard:
  // Rating 71 / Slope 116
  // -------------------------------------------------------
  {
    name: "myrtleford golf club",

    pars: [
      3,4,4,4,4,4,5,3,4,
      4,5,4,4,3,4,3,5,4
    ],

    rating: 71.0,
    slope: 116,
    tee: "Blue",
  },
    // =======================================================
  // VIC BATCH 6
  // North Victoria / Central Victoria
  // =======================================================


  // -------------------------------------------------------
  // NUMURKAH GOLF & BOWLS CLUB
  //
  // Official club scorecard:
  // Men Par 72
  // White: Scratch 71 / Slope 124
  // -------------------------------------------------------
  {
    name: "numurkah golf and bowls club",

    pars: [
      4,3,5,3,4,5,3,4,5,
      4,4,4,5,4,3,5,4,3
    ],

    rating: 71.0,
    slope: 124,
    tee: "White",
  },


  // -------------------------------------------------------
  // HIDDEN VALLEY RESORT
  //
  // Official course:
  // Par 73
  // White slope: 128
  //
  // Scratch rating is not clearly shown on the current
  // public course page, so leave rating null.
  // -------------------------------------------------------
  {
    name: "hidden valley resort",

    pars: [
      4,5,4,3,5,4,4,3,5,
      4,4,3,5,4,4,5,3,4
    ],

    rating: null,
    slope: 128,
    tee: "White",
  },
    // =======================================================
  // VIC BATCH 7
  // Western Victoria / Bellarine
  // =======================================================


  // -------------------------------------------------------
  // PORT FAIRY GOLF LINKS
  //
  // Men's course
  // Par 72
  // Rating: 71.8
  // Slope: 124
  //
  // Hole pars verified against published scorecard
  // and official individual-hole pages.
  // -------------------------------------------------------
  {
    name: "port fairy golf links",

    pars: [
      5,4,4,3,5,4,4,3,4,
      4,3,5,4,4,3,4,4,5
    ],

    rating: 71.8,
    slope: 124,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // CLIFTON SPRINGS GOLF CLUB
  //
  // Men's course
  // Par 71
  //
  // Official club confirms:
  // 18 holes
  // Men's Par 71
  // 5,783 metres
  //
  // Rating/slope left null until the applicable current
  // men's tee rating can be tied to this exact card.
  // -------------------------------------------------------
  {
    name: "clifton springs golf club",

    pars: [
      4,5,3,4,4,4,3,5,4,
      4,4,3,5,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },
    // =======================================================
  // VIC BATCH 8
  // Western Victoria / Melbourne North
  // =======================================================


  // -------------------------------------------------------
  // PORTLAND GOLF CLUB
  //
  // Official club course tour:
  // Men's Par 72
  // 5,812m
  //
  // Rating/slope left null because the official course
  // tour does not clearly tie a current scratch/slope
  // to this exact men's card.
  // -------------------------------------------------------
  {
    name: "portland golf club",

    pars: [
      4,4,5,4,3,4,5,3,4,
      4,3,4,5,4,4,5,4,3
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // CLUB MANDALAY
  //
  // Official Club Mandalay hole-by-hole guide.
  // Par 72
  // Official Golf Australia slope listed by club: 132
  //
  // Scratch rating left null because the club page
  // currently publishes slope but not a clearly matched
  // scratch rating for this card.
  // -------------------------------------------------------
  {
    name: "club mandalay",

    pars: [
      4,5,3,4,4,5,3,4,4,
      4,3,4,4,4,3,5,5,4
    ],

    rating: null,
    slope: 132,
    tee: "Men",
  },
    // =======================================================
  // VIC BATCH 9
  // Macedon Ranges / North-East Victoria
  // =======================================================


  // -------------------------------------------------------
  // KYNETON GOLF CLUB
  //
  // Official club course guide:
  // Men's Par 70
  //
  // Front 9: 35
  // Back 9: 35
  //
  // Rating/slope left null because published rating
  // information differs between current sources.
  // -------------------------------------------------------
  {
    name: "kyneton golf club",

    pars: [
      4,4,4,3,4,4,4,5,3,
      4,3,4,4,5,4,4,3,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // GISBORNE GOLF CLUB
  //
  // Men's course:
  // Par 72
  //
  // Hole pars are consistent across multiple current
  // published scorecards.
  //
  // Rating/slope left null because current sources
  // disagree on the exact men's rating/slope.
  // -------------------------------------------------------
  {
    name: "gisborne golf club",

    pars: [
      4,3,5,3,4,5,4,4,4,
      4,5,3,5,4,4,3,4,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // RUTHERGLEN GOLF CLUB
  //
  // Men's course:
  // Front 9: Par 36
  // Back 9: Par 33
  // Total: Par 69
  //
  // We previously held this one back because rating/slope
  // sources conflicted.
  //
  // Exact par sequence is now available, so add the
  // scorecard but leave rating/slope null.
  // -------------------------------------------------------
  {
    name: "rutherglen golf club",

    pars: [
      4,4,4,3,4,5,5,3,4,
      4,4,3,4,3,4,4,3,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },
    // =======================================================
  // VIC BATCH 10
  // Central Victoria / Bellarine
  // =======================================================


  // -------------------------------------------------------
  // TRENTHAM GOLF CLUB
  //
  // White course
  // Par 70
  // Rating: 67.3
  // Slope: 110
  //
  // Front 9: 35
  // Back 9: 35
  // -------------------------------------------------------
  {
    name: "trentham golf club",

    pars: [
      4,3,4,4,3,4,4,4,5,
      4,4,4,3,4,3,4,5,4
    ],

    rating: 67.3,
    slope: 110,
    tee: "White",
  },


  // -------------------------------------------------------
  // WOODEND GOLF CLUB
  //
  // IMPORTANT:
  // Available sources show different total pars depending
  // on the card/tee.
  //
  // Blue scorecard:
  // Front 9: 33
  // Back 9: 34
  // Total: Par 67
  //
  // We use the Blue card below.
  //
  // Rating/slope left null because published rating data
  // does not cleanly correspond with this exact Blue card.
  // -------------------------------------------------------
  {
    name: "woodend golf club",

    pars: [
      4,3,4,3,3,4,4,4,4,
      4,3,4,4,3,4,5,3,4
    ],

    rating: null,
    slope: null,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // QUEENSCLIFF GOLF CLUB
  //
  // Swan Island
  //
  // White:
  // Par 72
  // Rating: 71.3
  // Slope: 133
  //
  // Front 9: 35
  // Back 9: 37
  // -------------------------------------------------------
  {
    name: "queenscliff golf club",

    pars: [
      4,5,3,4,4,4,4,4,3,
      4,5,5,4,3,4,4,4,4
    ],

    rating: 71.3,
    slope: 133,
    tee: "White",
  },
    // =======================================================
  // VIC BATCH 11
  // Great Ocean Road / Bellarine Peninsula
  // =======================================================


  // -------------------------------------------------------
  // ANGLESEA GOLF CLUB
  //
  // Black
  // Par 73
  // Rating: 72.8
  // Slope: 132
  //
  // Front 9: 37
  // Back 9: 36
  // -------------------------------------------------------
  {
    name: "anglesea golf club",

    pars: [
      5,5,3,4,4,3,4,5,4,
      4,4,5,3,4,4,3,4,5
    ],

    rating: 72.8,
    slope: 132,
    tee: "Black",
  },


  // -------------------------------------------------------
  // RACV TORQUAY GOLF CLUB
  //
  // Black
  // Par 71
  // Rating: 71.4
  // Slope: 131
  //
  // Front 9: 36
  // Back 9: 35
  //
  // IMPORTANT:
  // This is RACV Torquay in Victoria, Australia.
  // Not Torquay Golf Club in Devon, UK.
  // -------------------------------------------------------
  {
    name: "racv torquay golf club",

    pars: [
      5,4,3,5,4,4,3,4,4,
      4,5,3,4,4,3,4,3,5
    ],

    rating: 71.4,
    slope: 131,
    tee: "Black",
  },


  // -------------------------------------------------------
  // CLIFTON SPRINGS GOLF CLUB
  //
  // Par 71
  //
  // Front 9: 34
  // Back 9: 37
  //
  // The published course data confirms the hole-by-hole
  // par sequence.
  //
  // Rating/slope data available online appears tied to
  // different distance/tee records, so we're leaving these
  // null rather than mixing scorecards.
  // -------------------------------------------------------
  {
    name: "clifton springs golf club",

    pars: [
      4,4,4,4,4,3,4,4,3,
      5,3,4,5,4,4,5,3,4
    ],

    rating: null,
    slope: null,
    tee: null,
  },
    // =======================================================
  // VIC BATCH 12
  // Melbourne Metro / Yarra Valley / Regional VIC
  // =======================================================


  // -------------------------------------------------------
  // RINGWOOD GOLF CLUB
  //
  // Official current Blue course
  // Par 71
  //
  // Hole-by-hole pars taken directly from club course guide.
  // -------------------------------------------------------
  {
    name: "ringwood golf club",

    pars: [
      4,4,3,5,3,5,4,3,4,
      4,4,3,5,4,4,3,4,4
    ],

    rating: null,
    slope: null,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // NORTHERN GOLF CLUB
  //
  // Official current Blue course
  // Par 72
  //
  // Glenroy, Victoria
  // -------------------------------------------------------
  {
    name: "northern golf club",

    pars: [
      4,4,5,3,4,3,4,5,4,
      4,5,4,5,3,4,3,4,4
    ],

    rating: null,
    slope: null,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // BOX HILL GOLF CLUB
  //
  // Official club course tour
  // Par 71
  //
  // Front 9: 35
  // Back 9: 36
  // -------------------------------------------------------
  {
    name: "box hill golf club",

    pars: [
      4,4,4,3,5,3,5,4,3,
      4,3,4,5,4,4,4,3,5
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // ALEXANDRA GOLF CLUB
  //
  // Official club course layout
  // Men's course
  // Par 70
  //
  // Front 9: 35
  // Back 9: 35
  // -------------------------------------------------------
  {
    name: "alexandra golf club",

    pars: [
      4,3,4,4,3,4,3,5,5,
      4,4,3,4,4,5,4,4,3
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // THE EASTERN GOLF CLUB - SOUTH COURSE
  //
  // Official Eastern Golf Club course guide
  // South Course
  // Par 72
  //
  // IMPORTANT:
  // Eastern has multiple courses, so retain "south course"
  // in the database name.
  // -------------------------------------------------------
  {
    name: "the eastern golf club - south course",

    pars: [
      4,5,4,4,4,3,4,3,5,
      4,5,4,3,5,4,4,3,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },
    // =======================================================
  // VIC BATCH 13
  // Melbourne North / West / Gippsland
  // =======================================================


  // -------------------------------------------------------
  // YARRAMBAT PARK GOLF COURSE
  //
  // Blue
  // Par 72
  //
  // Front 9: 36
  // Back 9: 36
  //
  // Official Yarrambat scorecard.
  // -------------------------------------------------------
  {
    name: "yarrambat park golf course",

    pars: [
      4,5,4,4,3,4,5,3,4,
      4,5,3,4,4,5,3,4,4
    ],

    rating: null,
    slope: null,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // WERRIBEE PARK GOLF CLUB
  //
  // Men's course
  // Par 72
  //
  // Front 9: 36
  // Back 9: 36
  //
  // Rating: 71
  // Slope: 128
  // -------------------------------------------------------
  {
    name: "werribee park golf club",

    pars: [
      4,4,3,5,4,4,4,3,5,
      4,5,4,4,4,3,5,3,4
    ],

    rating: 71,
    slope: 128,
    tee: "Men",
  },


  // -------------------------------------------------------
  // BACCHUS MARSH GOLF CLUB
  //
  // Blue
  // Par 72
  //
  // Front 9: 36
  // Back 9: 36
  //
  // Rating: 73
  // Slope: 125
  // -------------------------------------------------------
  {
    name: "bacchus marsh golf club",

    pars: [
      4,4,3,4,3,4,5,4,5,
      4,4,3,5,4,4,3,5,4
    ],

    rating: 73,
    slope: 125,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // MORWELL GOLF CLUB
  //
  // Men's course
  // Par 72
  //
  // Front 9: 36
  // Back 9: 36
  //
  // Hole pars verified against Morwell Golf Club's
  // own current scorecard.
  // -------------------------------------------------------
  {
    name: "morwell golf club",

    pars: [
      4,3,4,5,4,5,4,3,4,
      4,3,5,4,4,3,4,4,5
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // TRARALGON GOLF CLUB
  //
  // Blue
  // Par 72
  //
  // Front 9: 37
  // Back 9: 35
  //
  // Hole pars verified against Traralgon's current
  // official course tour.
  // -------------------------------------------------------
  {
    name: "traralgon golf club",

    pars: [
      4,5,4,4,3,5,5,3,4,
      3,4,4,4,4,3,5,4,4
    ],

    rating: null,
    slope: null,
    tee: "Blue",
  },
    // =======================================================
  // VIC BATCH 13
  // Melbourne North / West / Gippsland
  // =======================================================


  // -------------------------------------------------------
  // YARRAMBAT PARK GOLF COURSE
  //
  // Blue
  // Par 72
  //
  // Front 9: 36
  // Back 9: 36
  //
  // Official Yarrambat scorecard.
  // -------------------------------------------------------
  {
    name: "yarrambat park golf course",

    pars: [
      4,5,4,4,3,4,5,3,4,
      4,5,3,4,4,5,3,4,4
    ],

    rating: null,
    slope: null,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // WERRIBEE PARK GOLF CLUB
  //
  // Men's course
  // Par 72
  //
  // Front 9: 36
  // Back 9: 36
  //
  // Rating: 71
  // Slope: 128
  // -------------------------------------------------------
  {
    name: "werribee park golf club",

    pars: [
      4,4,3,5,4,4,4,3,5,
      4,5,4,4,4,3,5,3,4
    ],

    rating: 71,
    slope: 128,
    tee: "Men",
  },


  // -------------------------------------------------------
  // BACCHUS MARSH GOLF CLUB
  //
  // Blue
  // Par 72
  //
  // Front 9: 36
  // Back 9: 36
  //
  // Rating: 73
  // Slope: 125
  // -------------------------------------------------------
  {
    name: "bacchus marsh golf club",

    pars: [
      4,4,3,4,3,4,5,4,5,
      4,4,3,5,4,4,3,5,4
    ],

    rating: 73,
    slope: 125,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // MORWELL GOLF CLUB
  //
  // Men's course
  // Par 72
  //
  // Front 9: 36
  // Back 9: 36
  //
  // Hole pars verified against Morwell Golf Club's
  // own current scorecard.
  // -------------------------------------------------------
  {
    name: "morwell golf club",

    pars: [
      4,3,4,5,4,5,4,3,4,
      4,3,5,4,4,3,4,4,5
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // TRARALGON GOLF CLUB
  //
  // Blue
  // Par 72
  //
  // Front 9: 37
  // Back 9: 35
  //
  // Hole pars verified against Traralgon's current
  // official course tour.
  // -------------------------------------------------------
  {
    name: "traralgon golf club",

    pars: [
      4,5,4,4,3,5,5,3,4,
      3,4,4,4,4,3,5,4,4
    ],

    rating: null,
    slope: null,
    tee: "Blue",
  },
    // =======================================================
  // VIC BATCH 15
  // Melbourne / Mornington / Western Victoria
  // =======================================================


  // -------------------------------------------------------
  // VICTORIA GOLF CLUB
  //
  // Men's
  // Par 72
  // Rating: 71.1
  // Slope: 132
  //
  // Front 9: 36
  // Back 9: 36
  // -------------------------------------------------------
  {
    name: "victoria golf club",

    pars: [
      4,4,4,3,4,4,3,5,5,
      4,4,4,4,3,4,3,5,5
    ],

    rating: 71.1,
    slope: 132,
    tee: "Mens",
  },


  // -------------------------------------------------------
  // METROPOLITAN GOLF CLUB
  //
  // Men's
  // Par 72
  //
  // Front 9: 37
  // Back 9: 35
  //
  // Current public scorecard does not give a reliable
  // matched slope/rating for this exact men's card.
  // -------------------------------------------------------
  {
    name: "metropolitan golf club",

    pars: [
      4,3,4,5,4,5,3,5,4,
      4,3,4,3,5,4,4,4,4
    ],

    rating: null,
    slope: null,
    tee: "Mens",
  },


  // -------------------------------------------------------
  // ALBERT PARK PUBLIC GOLF COURSE
  //
  // Gentlemen
  // Par 72
  // Rating: 72
  // Slope: 113
  //
  // Front 9: 37
  // Back 9: 35
  // -------------------------------------------------------
  {
    name: "albert park public golf course",

    pars: [
      4,3,4,4,4,5,5,3,5,
      3,5,3,4,4,3,4,4,5
    ],

    rating: 72.0,
    slope: 113,
    tee: "Gentlemen",
  },


  // -------------------------------------------------------
  // EAGLE RIDGE GOLF CLUB
  //
  // Blue
  // Par 72
  // Rating: 73.4
  // Slope: 138
  //
  // Front 9: 36
  // Back 9: 36
  // -------------------------------------------------------
  {
    name: "eagle ridge golf club",

    pars: [
      4,4,4,4,4,3,5,3,5,
      4,3,4,4,4,4,5,3,5
    ],

    rating: 73.4,
    slope: 138,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // WARRNAMBOOL GOLF CLUB
  //
  // Men
  // Par 72
  //
  // Front 9: 35
  // Back 9: 37
  //
  // Western District Golf lists men's slope as 126,
  // but the detailed public scorecard doesn't tie a
  // scratch rating cleanly to this exact card.
  // -------------------------------------------------------
  {
    name: "warrnambool golf club",

    pars: [
      5,3,4,4,4,4,4,4,3,
      5,4,4,3,4,3,4,5,5
    ],

    rating: null,
    slope: 126,
    tee: "Men",
  },
    // =======================================================
  // VIC BATCH 16
  // Melbourne West / North / South-East / Yarra Valley
  // =======================================================


  // -------------------------------------------------------
  // SANCTUARY LAKES GOLF CLUB
  //
  // Black
  // Par 72
  //
  // Front 9: 36
  // Back 9: 36
  //
  // NOTE:
  // Multiple sources agree on the par layout.
  // Rating/slope sources conflict, so these are left null.
  // -------------------------------------------------------
  {
    name: "sanctuary lakes golf club",

    pars: [
      4,3,4,5,4,3,4,5,4,
      4,3,5,4,4,4,5,3,4
    ],

    rating: null,
    slope: null,
    tee: "Black",
  },


  // -------------------------------------------------------
  // KOORINGAL GOLF CLUB
  //
  // Black
  // Par 71
  // Rating: 72.1
  // Slope: 128
  //
  // Front 9: 36
  // Back 9: 35
  //
  // NOTE:
  // Some older databases contain a different Kooringal
  // scorecard. This record uses the current Black layout
  // published by 18Birdies.
  // -------------------------------------------------------
  {
    name: "kooringal golf club",

    pars: [
      5,4,4,4,3,4,5,3,4,
      4,4,4,3,4,4,3,4,5
    ],

    rating: 72.1,
    slope: 128,
    tee: "Black",
  },


  // -------------------------------------------------------
  // GROWLING FROG GOLF COURSE
  //
  // White
  // Par 72
  //
  // Front 9: 36
  // Back 9: 36
  //
  // Official course site confirms Par 72.
  // -------------------------------------------------------
  {
    name: "growling frog golf course",

    pars: [
      4,3,5,4,3,4,4,5,4,
      4,5,3,4,4,5,3,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // GARDINERS RUN GOLF COURSE
  //
  // Blue
  // Par 72
  // Rating: 72.3
  // Slope: 127
  //
  // Front 9: 36
  // Back 9: 36
  // -------------------------------------------------------
  {
    name: "gardiners run golf course",

    pars: [
      4,5,3,4,4,4,3,5,4,
      5,3,4,4,4,4,3,5,4
    ],

    rating: 72.3,
    slope: 127,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // SETTLERS RUN GOLF & COUNTRY CLUB
  //
  // Gold
  // Par 72
  // Rating: 72
  // Slope: 136
  //
  // Front 9: 36
  // Back 9: 36
  //
  // Official club course tour confirms the hole layout.
  // -------------------------------------------------------
  {
    name: "settlers run golf & country club",

    pars: [
      5,3,4,4,4,4,4,3,5,
      4,3,4,4,4,4,5,4,4
    ],

    rating: 72,
    slope: 136,
    tee: "Gold",
  },
    // =======================================================
  // VIC BATCH 17
  // Melbourne / Yarra Valley / Murray River
  // =======================================================


  // -------------------------------------------------------
  // BLACK BULL GOLF COURSE
  //
  // Yarrawonga
  // Par 72
  //
  // Front 9: 36
  // Back 9: 36
  //
  // Black: Rating 74 / Slope 133
  // -------------------------------------------------------
  {
    name: "black bull golf course",

    pars: [
      4,5,4,3,4,4,5,3,4,
      4,4,4,5,3,4,3,4,5
    ],

    rating: 74.0,
    slope: 133,
    tee: "Black",
  },


  // -------------------------------------------------------
  // HERITAGE GOLF & COUNTRY CLUB - ST JOHN
  //
  // Par 72
  //
  // Front 9: 36
  // Back 9: 36
  //
  // Official club currently lists:
  // Gold: Scratch 74 / Slope 139
  //
  // -------------------------------------------------------
  {
    name: "heritage golf & country club - st john",

    pars: [
      4,4,3,5,4,4,3,4,5,
      4,3,5,4,4,5,4,3,4
    ],

    rating: 74.0,
    slope: 139,
    tee: "Gold",
  },


  // -------------------------------------------------------
  // GLEN WAVERLEY GOLF COURSE
  //
  // Men's course
  // Par 68
  // Slope 121
  //
  // NOTE:
  // Holes 4 and 5 change par for the shorter setup.
  // TeeRadar record below uses the men's LONG configuration.
  // -------------------------------------------------------
  {
    name: "glen waverley golf course",

    pars: [
      4,4,3,4,4,4,3,4,4,
      3,4,3,4,4,4,4,4,3
    ],

    rating: 67.0,
    slope: 121,
    tee: "Men Long",
  },


  // -------------------------------------------------------
  // PENINSULA KINGSWOOD - NORTH COURSE
  //
  // Black
  // Par 72
  // Rating: 73.3
  // Slope: 134
  //
  // Front 9: 36
  // Back 9: 36
  //
  // Keep North in the name because Peninsula Kingswood
  // operates two separate championship courses.
  // -------------------------------------------------------
  {
    name: "peninsula kingswood - north course",

    pars: [
      4,3,5,4,5,4,3,4,4,
      4,4,4,4,3,5,3,5,4
    ],

    rating: 73.3,
    slope: 134,
    tee: "Black",
  },


  // -------------------------------------------------------
  // LATROBE GOLF CLUB
  //
  // Blue
  // Par 72
  //
  // Front 9: 35
  // Back 9: 37
  //
  // Rating: 72.1
  // Slope: 128
  // -------------------------------------------------------
  {
    name: "latrobe golf club",

    pars: [
      3,5,4,4,4,4,4,4,3,
      4,3,5,3,4,4,5,4,5
    ],

    rating: 72.1,
    slope: 128,
    tee: "Blue",
  },

];

const COURSE_ROWS = [
  ...STANDARD_COURSES.flatMap(makeStandardCourse),
];

export async function seedVicScorecards() {

  console.log(
    `🏌️ VIC scorecard seed starting (${COURSE_ROWS.length} templates)`
  );

  let insertedOrUpdated = 0;

  for (const course of COURSE_ROWS) {

    const holes = Number(course.holes);

    if (![9, 18].includes(holes)) {
      throw new Error(`${course.name}: invalid hole count`);
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

    const rating =
      course.rating === null ||
      typeof course.rating === "undefined"
        ? null
        : Number(course.rating);

    if (
      rating !== null &&
      !Number.isFinite(rating)
    ) {
      throw new Error(
        `${course.name}: invalid course rating`
      );
    }

    const slope =
      course.slope === null ||
      typeof course.slope === "undefined"
        ? null
        : Number(course.slope);

    if (
      slope !== null &&
      (
        !Number.isFinite(slope) ||
        slope < 55 ||
        slope > 155
      )
    ) {
      throw new Error(
        `${course.name}: invalid slope rating`
      );
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
        'VIC',
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
        course.tee,
      ]
    );

    insertedOrUpdated++;
  }

  console.log(
    `✅ VIC scorecard seed complete (${insertedOrUpdated} templates)`
  );

  return {
    ok: true,
    courses: STANDARD_COURSES.length,
    templates: insertedOrUpdated,
  };
}
