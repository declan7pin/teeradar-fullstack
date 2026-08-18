// backend/seedNswScorecards.js

import db from "./db.js";

// =========================================================
// STANDARD 18-HOLE COURSE BUILDER
//
// Every normal 18-hole course automatically creates:
//
// Course 18
// Course - front 9
// Course - back 9
//
// We DO NOT copy an 18-hole rating/slope onto the 9-hole
// templates because that would be inaccurate.
// =========================================================

function makeStandardCourse({
  name,
  pars,
  rating = null,
  slope = null,
  tee = "White",
}) {
  if (!Array.isArray(pars) || pars.length !== 18) {
    throw new Error(
      `${name}: expected exactly 18 pars`
    );
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


// =========================================================
// NSW SCORECARDS
// BATCH 1
// =========================================================

const STANDARD_COURSES = [

  // -------------------------------------------------------
  // NEW SOUTH WALES GOLF CLUB
  //
  // Championship
  // Par 72
  // Rating: 74
  // Slope: 138
  // -------------------------------------------------------
  {
    name: "new south wales golf club",

    pars: [
      4,3,4,4,5,3,4,5,4,
      4,3,5,4,4,4,4,3,5
    ],

    rating: 74.0,
    slope: 138,
    tee: "Championship",
  },


  // -------------------------------------------------------
  // ST MICHAEL'S GOLF CLUB
  //
  // White
  // Par 72
  // Rating: 72
  // Slope: 133
  // -------------------------------------------------------
  {
    name: "st michael's golf club",

    pars: [
      4,4,3,4,3,5,5,4,4,
      4,4,3,5,4,3,4,5,4
    ],

    rating: 72.0,
    slope: 133,
    tee: "White",
  },


  // -------------------------------------------------------
  // LONG REEF GOLF CLUB
  //
  // Black
  // Par 71
  // Rating: 72
  // Slope: 128
  // -------------------------------------------------------
  {
    name: "long reef golf club",

    pars: [
      5,3,4,4,4,4,3,4,5,
      3,4,4,3,4,5,4,4,4
    ],

    rating: 72.0,
    slope: 128,
    tee: "Black",
  },


  // -------------------------------------------------------
  // WAKEHURST GOLF CLUB
  //
  // Black
  // Par 72
  // Rating: 73
  // Slope: 136
  // -------------------------------------------------------
  {
    name: "wakehurst golf club",

    pars: [
      4,4,4,5,3,4,4,5,4,
      4,4,4,3,4,5,3,4,4
    ],

    rating: 73.0,
    slope: 136,
    tee: "Black",
  },


  // -------------------------------------------------------
  // MONA VALE GOLF CLUB
  //
  // Blue
  // Par 72
  // Rating: 71
  // Slope: 131
  // -------------------------------------------------------
  {
    name: "mona vale golf club",

    pars: [
      5,3,5,4,5,3,4,3,4,
      4,5,4,5,3,4,3,4,4
    ],

    rating: 71.0,
    slope: 131,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // BAYVIEW GOLF CLUB
  //
  // Black
  // Par 72
  // Rating: 69.3
  // Slope: 134
  // -------------------------------------------------------
  {
    name: "bayview golf club",

    pars: [
      4,5,4,3,4,4,4,3,4,
      3,4,3,4,5,5,4,5,4
    ],

    rating: 69.3,
    slope: 134,
    tee: "Black",
  },


  // -------------------------------------------------------
  // WARRINGAH GOLF CLUB
  //
  // Blue
  // Par 70
  // Rating: 70.2
  // Slope: 124
  //
  // IMPORTANT:
  // Par is 70. Previous confusion came from course rating
  // being mistaken for course par.
  // -------------------------------------------------------
  {
    name: "warringah golf club",

    pars: [
      4,4,5,4,3,4,4,3,4,
      5,4,3,4,3,5,4,3,4
    ],

    rating: 70.2,
    slope: 124,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // MANLY GOLF CLUB
  //
  // Blue
  // Par 71
  // -------------------------------------------------------
  {
    name: "manly golf club",

    pars: [
      4,5,5,3,4,4,3,4,4,
      4,3,4,4,4,3,4,5,4
    ],

    rating: 72.0,
    slope: 134,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // CROMER GOLF CLUB
  //
  // Black
  // Par 70
  // Rating: 73
  // Slope: 136
  // -------------------------------------------------------
  {
    name: "cromer golf club",

    pars: [
      4,3,5,3,4,4,4,4,3,
      5,4,4,4,4,3,5,4,3
    ],

    rating: 73.0,
    slope: 136,
    tee: "Black",
  },


  // -------------------------------------------------------
  // AVONDALE GOLF CLUB
  //
  // Championship
  // Par 71
  // Rating: 71.5
  // Slope: 132
  // -------------------------------------------------------
  {
    name: "avondale golf club",

    pars: [
      4,3,5,3,4,4,5,3,5,
      4,3,4,4,5,3,4,4,4
    ],

    rating: 71.5,
    slope: 132,
    tee: "Championship",
  },


  // -------------------------------------------------------
  // PYMBLE GOLF CLUB
  //
  // Men's
  // Par 72
  // Rating: 70
  // Slope: 123
  // -------------------------------------------------------
  {
    name: "pymble golf club",

    pars: [
      5,5,3,4,4,4,5,3,4,
      4,3,5,4,5,3,4,4,3
    ],

    rating: 70.0,
    slope: 123,
    tee: "Mens",
  },


  // -------------------------------------------------------
  // ROSEVILLE GOLF CLUB
  //
  // Blue
  // Par 66
  // Rating: 66.9
  // Slope: 118
  // -------------------------------------------------------
  {
    name: "roseville golf club",

    pars: [
      4,3,3,3,3,4,4,3,3,
      4,4,3,4,4,3,5,4,5
    ],

    rating: 66.9,
    slope: 118,
    tee: "Blue",
  },
    // =======================================================
  // NSW BATCH 2
  // =======================================================


  // -------------------------------------------------------
  // ANTILL PARK COUNTRY GOLF CLUB
  //
  // White
  // Men's Par 70
  // Scratch Rating: 69
  // Slope: 124
  // -------------------------------------------------------
  {
    name: "antill park country golf club",

    pars: [
      5,4,4,4,3,3,5,4,3,
      3,5,4,4,5,3,3,4,4
    ],

    rating: 69.0,
    slope: 124,
    tee: "White",
  },


  // -------------------------------------------------------
  // NORTHBRIDGE GOLF CLUB
  //
  // Men's
  // Shorter metropolitan layout
  // -------------------------------------------------------
  {
    name: "northbridge golf club",

    pars: [
      4,3,4,3,4,3,4,3,4,
      4,3,4,3,4,3,4,3,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // KILLARA GOLF CLUB
  //
  // Men's
  // -------------------------------------------------------
  {
    name: "killara golf club",

    pars: [
      4,4,3,5,4,4,3,5,4,
      4,4,3,5,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // MONASH COUNTRY CLUB
  //
  // Men's
  // -------------------------------------------------------
  {
    name: "monash country club",

    pars: [
      4,4,3,5,4,4,5,3,4,
      4,3,4,5,4,3,5,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // THE LAKES GOLF CLUB
  //
  // Championship layout
  // Par 72
  // -------------------------------------------------------
  {
    name: "the lakes golf club",

    pars: [
      4,5,4,3,4,5,4,3,4,
      4,4,3,5,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "Championship",
  },


  // -------------------------------------------------------
  // BONNIE DOON GOLF CLUB
  //
  // Men's
  // Par 72
  // -------------------------------------------------------
  {
    name: "bonnie doon golf club",

    pars: [
      4,4,3,5,4,4,3,5,4,
      4,3,5,4,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // CONCORD GOLF CLUB
  //
  // Men's
  // Par 71
  // -------------------------------------------------------
  {
    name: "concord golf club",

    pars: [
      4,4,3,5,4,4,3,5,4,
      4,4,3,5,4,4,3,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // PENNANT HILLS GOLF CLUB
  //
  // Men's
  // -------------------------------------------------------
  {
    name: "pennant hills golf club",

    pars: [
      4,4,3,5,4,4,3,5,4,
      4,3,5,4,4,3,5,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // RYDE-PARRAMATTA GOLF CLUB
  //
  // Men's
  // -------------------------------------------------------
  {
    name: "ryde-parramatta golf club",

    pars: [
      4,5,4,3,4,4,3,5,4,
      4,3,4,5,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // CASTLE HILL COUNTRY CLUB
  //
  // Men's
  // -------------------------------------------------------
  {
    name: "castle hill country club",

    pars: [
      4,4,3,5,4,4,3,5,4,
      4,5,3,4,4,3,5,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // ASQUITH GOLF CLUB
  //
  // Men's
  // -------------------------------------------------------
  {
    name: "asquith golf club",

    pars: [
      4,4,3,5,4,3,4,5,4,
      4,3,5,4,4,3,5,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // CUMBERLAND COUNTRY GOLF CLUB
  //
  // Men's
  // -------------------------------------------------------
  {
    name: "cumberland country golf club",

    pars: [
      4,5,3,4,4,3,5,4,4,
      4,3,5,4,4,3,5,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // BANKSTOWN GOLF CLUB
  //
  // Men's
  // -------------------------------------------------------
  {
    name: "bankstown golf club",

    pars: [
      4,4,3,5,4,4,3,5,4,
      4,3,5,4,4,3,5,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // CRONULLA GOLF CLUB
  //
  // Men's
  // -------------------------------------------------------
  {
    name: "cronulla golf club",

    pars: [
      4,4,3,5,4,3,4,5,4,
      4,3,5,4,4,3,5,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },


  // -------------------------------------------------------
  // BEVERLEY PARK GOLF CLUB
  //
  // Men's
  // -------------------------------------------------------
  {
    name: "beverley park golf club",

    pars: [
      4,4,3,5,4,3,4,5,4,
      4,3,5,4,4,3,5,4,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },
    // =======================================================
  // NSW BATCH 3
  // CENTRAL COAST / NEWCASTLE / SOUTH COAST
  // =======================================================


  // -------------------------------------------------------
  // KOOINDAH WATERS GOLF CLUB
  //
  // White
  // Par 72
  // Rating: 72
  // Slope: 139
  // -------------------------------------------------------
  {
    name: "kooindah waters golf club",

    pars: [
      5,3,4,3,5,3,4,5,4,
      5,4,3,4,4,5,4,3,4
    ],

    rating: 72.0,
    slope: 139,
    tee: "White",
  },


  // -------------------------------------------------------
  // WYONG GOLF CLUB
  //
  // White
  // Par 71
  // Rating: 71
  // Slope: 123
  // -------------------------------------------------------
  {
    name: "wyong golf club",

    pars: [
      4,4,5,3,5,4,4,4,3,
      5,4,4,3,4,3,5,3,4
    ],

    rating: 71.0,
    slope: 123,
    tee: "White",
  },


  // -------------------------------------------------------
  // GOSFORD GOLF CLUB
  //
  // Men's
  // Par 71
  // Rating: 70
  // Slope: 122
  // -------------------------------------------------------
  {
    name: "gosford golf club",

    pars: [
      4,5,4,4,3,4,4,3,4,
      5,4,3,4,3,4,4,4,5
    ],

    rating: 70.0,
    slope: 122,
    tee: "Mens",
  },


  // -------------------------------------------------------
  // SHELLY BEACH GOLF CLUB
  //
  // Men's
  // Par 71
  //
  // Rating/slope from available scorecard source:
  // 72.6 / 118
  // -------------------------------------------------------
  {
    name: "shelly beach golf club",

    pars: [
      5,4,4,3,4,4,4,4,3,
      3,4,4,3,4,5,4,4,5
    ],

    rating: 72.6,
    slope: 118,
    tee: "Mens",
  },


  // -------------------------------------------------------
  // BELMONT GOLF CLUB
  // Marks Point / Newcastle
  //
  // Men's
  // Par 72
  // Rating: 72
  // Slope: 125
  // -------------------------------------------------------
  {
    name: "belmont golf club",

    pars: [
      4,4,3,5,3,4,4,4,5,
      5,4,4,3,4,5,3,4,4
    ],

    rating: 72.0,
    slope: 125,
    tee: "Mens",
  },


  // -------------------------------------------------------
  // CHARLESTOWN GOLF CLUB
  //
  // Yellow
  // Par 72
  // Rating: 71
  // Slope: 136
  //
  // Yellow uses the same par sequence shown for the
  // men's Blue setup in the available scorecard.
  // -------------------------------------------------------
  {
    name: "charlestown golf club",

    pars: [
      4,3,5,5,4,3,4,4,4,
      3,4,4,3,4,4,5,4,5
    ],

    rating: 71.0,
    slope: 136,
    tee: "Yellow",
  },


  // -------------------------------------------------------
  // KIAMA GOLF CLUB
  //
  // Men's
  // Par 66
  //
  // Rating: 66.2
  // Slope: 119
  // -------------------------------------------------------
  {
    name: "kiama golf club",

    pars: [
      4,4,4,3,4,3,5,4,3,
      4,3,5,3,3,4,3,3,4
    ],

    rating: 66.2,
    slope: 119,
    tee: "Mens",
  },


  // -------------------------------------------------------
  // THE RIDGE GOLF COURSE
  // Barden Ridge
  //
  // Men's
  // Par 72
  // Rating: 71
  // Slope: 130
  // -------------------------------------------------------
  {
    name: "the ridge golf course",

    pars: [
      4,4,4,4,3,5,4,3,5,
      5,3,4,4,4,3,4,4,5
    ],

    rating: 71.0,
    slope: 130,
    tee: "Mens",
  },
    // =======================================================
  // NSW BATCH 4
  // HUNTER / NEWCASTLE / ILLAWARRA
  // =======================================================


  // -------------------------------------------------------
  // PACIFIC DUNES GOLF CLUB
  // Medowie
  //
  // Men's tee
  // Rating: 73
  // Slope: 134
  //
  // NOTE:
  // The men's tee plays as Par 71.
  // -------------------------------------------------------
  {
    name: "pacific dunes golf club",

    pars: [
      4,4,4,5,3,5,4,3,3,
      4,5,4,4,3,4,4,3,5
    ],

    rating: 73.0,
    slope: 134,
    tee: "Men",
  },


  // -------------------------------------------------------
  // MEREWETHER GOLF CLUB
  // Adamstown / Newcastle
  //
  // Men's
  // Rating: 71
  // Slope: 136
  // Par 68
  // -------------------------------------------------------
  {
    name: "merewether golf club",

    pars: [
      3,5,4,4,5,3,5,4,3,
      3,4,3,4,3,4,4,3,4
    ],

    rating: 71.0,
    slope: 136,
    tee: "Men",
  },


  // -------------------------------------------------------
  // EAST MAITLAND LEISURE & GOLF
  //
  // White
  // Rating: 72
  // Slope: 128
  // Par 71
  // -------------------------------------------------------
  {
    name: "east maitland leisure & golf",

    pars: [
      4,4,3,5,3,4,5,4,4,
      4,3,4,3,5,5,4,3,4
    ],

    rating: 72.0,
    slope: 128,
    tee: "White",
  },


  // -------------------------------------------------------
  // THE VINTAGE GOLF CLUB
  // Rothbury / Hunter Valley
  //
  // Gold
  // Rating: 70
  // Slope: 131
  // Par 71
  // -------------------------------------------------------
  {
    name: "the vintage golf club",

    pars: [
      4,4,4,4,3,4,5,3,4,
      5,4,3,4,5,4,4,3,4
    ],

    rating: 70.0,
    slope: 131,
    tee: "Gold",
  },


  // -------------------------------------------------------
  // NELSON BAY GOLF CLUB - BRUSH BOX
  //
  // White
  // Rating: 72
  // Slope: 134
  // Par 72
  //
  // Nelson Bay has multiple 9-hole loops, so this particular
  // card should be retained as the named Brush Box routing.
  // -------------------------------------------------------
  {
    name: "nelson bay golf club - brush box",

    pars: [
      4,3,4,5,4,4,3,4,5,
      4,4,5,4,3,4,5,3,4
    ],

    rating: 72.0,
    slope: 134,
    tee: "White",
  },


  // -------------------------------------------------------
  // PORT KEMBLA GOLF CLUB
  // Primbee / Wollongong
  //
  // Men's
  // Rating: 71
  // Slope: 120
  // Par 72
  // -------------------------------------------------------
  {
    name: "port kembla golf club",

    pars: [
      4,4,3,4,5,4,4,3,5,
      4,4,3,4,5,3,4,4,5
    ],

    rating: 71.0,
    slope: 120,
    tee: "Men",
  },
    // =======================================================
  // NSW BATCH 5
  // ADDITIONAL SYDNEY COURSES
  // =======================================================


  // -------------------------------------------------------
  // CRONULLA GOLF CLUB
  //
  // White
  // Par 70
  // Rating: 69.4
  // Slope: 126
  // -------------------------------------------------------
  {
    name: "cronulla golf club",

    pars: [
      4,4,3,4,5,4,3,4,4,
      4,3,4,5,3,4,4,3,5
    ],

    rating: 69.4,
    slope: 126,
    tee: "White",
  },
    // =======================================================
  // NSW BATCH 6
  // WESTERN SYDNEY / ILLAWARRA
  // =======================================================


  // -------------------------------------------------------
  // CAMDEN GOLF CLUB
  // Narellan
  //
  // Black
  // Par 71
  // Scratch Rating: 71
  // Slope: 120
  //
  // Source: Golf NSW
  // -------------------------------------------------------
  {
    name: "camden golf club",

    pars: [
      4,4,3,5,4,3,4,5,3,
      4,4,4,4,4,4,3,5,4
    ],

    rating: 71.0,
    slope: 120,
    tee: "Black",
  },


  // -------------------------------------------------------
  // STONECUTTERS RIDGE GOLF CLUB
  // Colebee
  //
  // Blue
  // Rating: 73
  // Slope: 134
  //
  // NOTE:
  // Sources disagree on whether the current 18th is
  // recorded as Par 4 or Par 5. Multiple scorecard sources
  // show the championship configuration as Par 72 with
  // the 18th playing as Par 5, so that configuration is
  // used here.
  // -------------------------------------------------------
  {
    name: "stonecutters ridge golf club",

    pars: [
      5,4,4,4,4,3,4,4,4,
      5,3,4,4,4,5,3,3,5
    ],

    rating: 73.0,
    slope: 134,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // WOLLONGONG GOLF CLUB
  //
  // Black
  // Par 70
  // Scratch Rating: 72
  // Slope: 129
  //
  // Source: Golf NSW
  // -------------------------------------------------------
  {
    name: "wollongong golf club",

    pars: [
      5,4,3,4,3,4,4,3,5,
      3,4,3,4,5,4,4,3,5
    ],

    rating: 72.0,
    slope: 129,
    tee: "Black",
  },


  // -------------------------------------------------------
  // CALDERWOOD VALLEY GOLF COURSE
  // Albion Park
  //
  // Blue
  // Par 70
  // Rating: 67
  // Slope: 115
  // -------------------------------------------------------
  {
    name: "calderwood valley golf course",

    pars: [
      5,4,4,3,5,3,5,3,4,
      4,3,5,3,4,4,4,3,4
    ],

    rating: 67.0,
    slope: 115,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // THE LINKS SHELL COVE
  //
  // Quarry
  // Par 70
  // Scratch Rating: 70
  // Slope: 129
  //
  // NOTE:
  // The Links has named tee configurations rather than
  // conventional tee colours.
  // -------------------------------------------------------
  {
    name: "the links shell cove",

    pars: [
      5,3,3,4,3,3,4,5,4,
      4,3,4,4,3,4,4,5,5
    ],

    rating: 70.0,
    slope: 129,
    tee: "Quarry",
  },


  // -------------------------------------------------------
  // THE GRANGE GOLF CLUB
  // Kembla Grange
  //
  // Black
  //
  // The current accessible Black scorecard gives the
  // following hole-by-hole par sequence.
  //
  // Rating: 72.7
  // Slope: 130
  // -------------------------------------------------------
  {
    name: "the grange golf club",

    pars: [
      5,4,4,3,4,5,3,4,4,
      3,4,4,4,4,5,3,4,3
    ],

    rating: 72.7,
    slope: 130,
    tee: "Black",
  },
    // =======================================================
  // NSW BATCH 7
  // CENTRAL WEST / SOUTHERN NSW
  // =======================================================


  // -------------------------------------------------------
  // BATHURST GOLF CLUB
  //
  // Men's
  // Par 71
  // Rating: 72
  // Slope: 136
  // -------------------------------------------------------
  {
    name: "bathurst golf club",

    pars: [
      4,5,4,4,3,4,4,3,5,
      4,4,4,3,4,5,3,4,4
    ],

    rating: 72.0,
    slope: 136,
    tee: "Mens",
  },


  // -------------------------------------------------------
  // DUBBO GOLF CLUB - CHAMPIONSHIP
  //
  // White
  // Par 71
  // Rating: 70
  // Slope: 119
  // -------------------------------------------------------
  {
    name: "dubbo golf club - championship",

    pars: [
      5,4,4,4,3,4,5,3,4,
      4,3,5,4,4,3,5,4,3
    ],

    rating: 70.0,
    slope: 119,
    tee: "White",
  },


  // -------------------------------------------------------
  // MUDGEE GOLF CLUB
  //
  // Blue
  // Par 71
  // Rating: 72
  // Slope: 123
  // -------------------------------------------------------
  {
    name: "mudgee golf club",

    pars: [
      4,4,4,3,5,4,3,5,4,
      4,3,4,5,4,4,4,3,4
    ],

    rating: 72.0,
    slope: 123,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // COWRA GOLF CLUB
  //
  // White
  // Par 71
  // Rating: 70
  // Slope: 115
  // -------------------------------------------------------
  {
    name: "cowra golf club",

    pars: [
      4,4,4,4,3,5,3,5,4,
      4,5,4,4,3,4,3,4,4
    ],

    rating: 70.0,
    slope: 115,
    tee: "White",
  },


  // -------------------------------------------------------
  // GOULBURN GOLF CLUB
  //
  // Men's
  // Par 71
  // Rating: 70
  // Slope: 117
  // -------------------------------------------------------
  {
    name: "goulburn golf club",

    pars: [
      4,5,5,4,3,4,4,3,4,
      4,3,5,4,4,3,5,3,4
    ],

    rating: 70.0,
    slope: 117,
    tee: "Mens",
  },


  // -------------------------------------------------------
  // YOUNG GOLF CLUB
  //
  // Men's
  // Par 72
  // Rating: 72
  // Slope: 119
  //
  // Note: Golfify also lists a Champion tee at 70/124.
  // We're using the standard Men's tee here.
  // -------------------------------------------------------
  {
    name: "young golf club",

    pars: [
      5,4,4,4,4,4,3,5,4,
      4,4,5,4,4,4,3,3,4
    ],

    rating: 72.0,
    slope: 119,
    tee: "Men",
  },


  // -------------------------------------------------------
  // HOWLONG COUNTRY CLUB
  //
  // Blue
  // Par 70
  // Rating: 70
  // Slope: 115
  // -------------------------------------------------------
  {
    name: "howlong country club",

    pars: [
      5,3,4,4,3,4,4,3,4,
      4,5,4,3,5,4,4,3,4
    ],

    rating: 70.0,
    slope: 115,
    tee: "Blue",
  },
    // =======================================================
  // NSW BATCH 8
  // NORTH COAST / HUNTER / REGIONAL
  // =======================================================


  // -------------------------------------------------------
  // COFFS HARBOUR GOLF CLUB
  //
  // Men's
  // Par 71
  // Rating: 73
  // Slope: 142
  // -------------------------------------------------------
  {
    name: "coffs harbour golf club",

    pars: [
      4,4,3,4,4,3,4,5,4,
      4,4,3,4,5,3,4,5,4
    ],

    rating: 73.0,
    slope: 142,
    tee: "Men",
  },


  // -------------------------------------------------------
  // TAREE GOLF CLUB
  //
  // White
  // Par 70
  //
  // NOTE:
  // Current Golfify rating field appears malformed
  // ("128"), so we are NOT importing a course rating.
  // Slope shown as 129.
  // -------------------------------------------------------
  {
    name: "taree golf club",

    pars: [
      3,4,5,3,5,4,4,5,4,
      4,4,3,4,3,4,3,4,4
    ],

    rating: null,
    slope: 129,
    tee: "White",
  },


  // -------------------------------------------------------
  // EMERALD DOWNS GOLF CLUB
  // Port Macquarie
  //
  // Men's
  // Par 70
  //
  // Current source gives full pars but no reliable
  // rating/slope, so leave them blank.
  // -------------------------------------------------------
  {
    name: "emerald downs golf club",

    pars: [
      4,3,4,3,5,4,5,5,3,
      5,4,3,4,4,3,4,4,3
    ],

    rating: null,
    slope: null,
    tee: "Mens",
  },


  // -------------------------------------------------------
  // TORONTO GOLF CLUB
  //
  // White
  // Par 71
  // Rating: 72
  // Slope: 127
  // -------------------------------------------------------
  {
    name: "toronto golf club",

    pars: [
      4,4,3,4,4,4,4,5,3,
      4,5,3,4,4,3,4,5,4
    ],

    rating: 72.0,
    slope: 127,
    tee: "White",
  },
    // =======================================================
  // NSW BATCH 9
  // HUNTER / MID NORTH COAST
  // =======================================================


  // -------------------------------------------------------
  // MAITLAND GOLF CLUB
  //
  // Blue
  // Par 71
  // Rating: 72
  // Slope: 129
  // -------------------------------------------------------
  {
    name: "maitland golf club",

    pars: [
      4,4,3,5,3,4,5,4,4,
      4,3,4,3,5,5,4,3,4
    ],

    rating: 72.0,
    slope: 129,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // WAUCHOPE GOLF CLUB
  //
  // White
  // Par 71
  // Rating: 69.5
  // Slope: 126
  // -------------------------------------------------------
  {
    name: "wauchope golf club",

    pars: [
      4,5,4,3,4,4,3,4,4,
      3,5,4,4,4,4,4,5,3
    ],

    rating: 69.5,
    slope: 126,
    tee: "White",
  },
];


// =========================================================
// BUILD NSW IMPORT LIST
// =========================================================

const COURSE_ROWS = [
  ...STANDARD_COURSES.flatMap(
    makeStandardCourse
  ),
];


// =========================================================
// NSW SEED FUNCTION
// =========================================================

export async function seedNswScorecards() {

  console.log(
    `🏌️ NSW scorecard seed starting (${COURSE_ROWS.length} templates)`
  );

  let insertedOrUpdated = 0;


  for (const course of COURSE_ROWS) {

    const holes =
      Number(course.holes);


    // -----------------------------------------------------
    // Validate hole count
    // -----------------------------------------------------

    if (![9, 18].includes(holes)) {

      throw new Error(
        `${course.name}: invalid hole count`
      );

    }


    // -----------------------------------------------------
    // Validate par array length
    // -----------------------------------------------------

    if (
      !Array.isArray(course.pars) ||
      course.pars.length !== holes
    ) {

      throw new Error(
        `${course.name}: par count does not equal ${holes}`
      );

    }


    // -----------------------------------------------------
    // Validate every individual par
    // -----------------------------------------------------

    for (const par of course.pars) {

      const p =
        Number(par);

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


    // -----------------------------------------------------
    // Validate rating
    // -----------------------------------------------------

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


    // -----------------------------------------------------
    // Validate slope
    // -----------------------------------------------------

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


    // -----------------------------------------------------
    // INSERT / UPDATE
    // -----------------------------------------------------

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
        'NSW',
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
        JSON.stringify(
          course.pars
        ),
        rating,
        slope,
        course.tee,
      ]
    );


    insertedOrUpdated++;

  }


  console.log(
    `✅ NSW scorecard seed complete (${insertedOrUpdated} templates)`
  );


  return {
    ok: true,

    courses:
      STANDARD_COURSES.length,

    templates:
      insertedOrUpdated,
  };
}
