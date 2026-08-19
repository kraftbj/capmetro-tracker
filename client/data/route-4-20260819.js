/*
 * Generated copy of tests/fixtures/golden/route-4-20260819.json, verbatim.
 * It exists because fetch() is blocked for file:// URLs, and the board must be
 * openable straight from disk with no server. app.js prefers a real HTTP fetch
 * whenever one is available and only falls back to this.
 * Regenerate: node client/data/regenerate.js
 */
window.CMB_FIXTURES = window.CMB_FIXTURES || {};
window.CMB_FIXTURES["4"] =
{
 "schema": 1,
 "generated_at": 1787152239,
 "route": {
  "id": "4",
  "short_name": "4",
  "long_name": "4-7th Street",
  "directions": [
   {
    "id": 0,
    "headsign": "4 Mopac WB"
   },
   {
    "id": 1,
    "headsign": "4 Shady EB"
   }
  ]
 },
 "feeds": {
  "positions_at": 1787152239,
  "trip_updates_at": 1787152196,
  "alerts_at": 1787152139,
  "gtfs_feed_version": "260818_1456",
  "gtfs_built_at": 1787100239
 },
 "staleness": {
  "level": "fresh",
  "oldest_feed_age_s": 43,
  "schedule_age_days": 1,
  "suppress_adherence": false,
  "reason": null
 },
 "service_day": {
  "date": "20260819",
  "service_ids": [
   "3-172"
  ],
  "is_exception_day": true
 },
 "vehicles": [
  {
   "vehicle_id": "2216",
   "label": "2216",
   "position": {
    "lat": 30.270388,
    "lon": -97.75505,
    "bearing": null,
    "speed_mps": 0.044704
   },
   "position_at": 1787152237,
   "in_service": true,
   "route_id": "4",
   "route_short_name": "4",
   "trip": {
    "trip_id": "3014769_15202",
    "start_time": "10:05:00",
    "start_epoch": 1787151900,
    "direction_id": 1,
    "headsign": "4 Shady EB",
    "schedule_relationship": "SCHEDULED"
   },
   "progress": {
    "current_stop_sequence": 5,
    "current_stop_id": "2107",
    "current_status": "IN_TRANSIT_TO"
   },
   "adherence": {
    "state": "ontime",
    "seconds": -13,
    "glyph": "circle",
    "against": {
     "stop_id": "2107",
     "stop_name": "5th/Bowie",
     "stop_sequence": 5,
     "scheduled_at": 1787152297,
     "predicted_at": 1787152284
    },
    "reason": null
   },
   "pattern": {
    "is_baseline": true,
    "is_special": false,
    "trips_in_pattern": 397,
    "adds": [],
    "skips": []
   },
   "block": {
    "block_id": "4004",
    "confidence": "high",
    "next_trip": {
     "trip_id": "3014710_15497",
     "direction_id": 0,
     "start_time": "10:53:00",
     "start_epoch": 1787154780,
     "start_stop_id": "1368",
     "start_stop_name": "Pleasant Valley/5th",
     "is_direction_flip": true
    }
   }
  },
  {
   "vehicle_id": "2701",
   "label": "2701",
   "position": {
    "lat": 30.261444,
    "lon": -97.71693,
    "bearing": null,
    "speed_mps": 0.0
   },
   "position_at": 1787152237,
   "in_service": true,
   "route_id": "4",
   "route_short_name": "4",
   "trip": {
    "trip_id": "3014707_15609",
    "start_time": "10:05:00",
    "start_epoch": 1787151900,
    "direction_id": 0,
    "headsign": "4 Mopac WB",
    "schedule_relationship": "SCHEDULED"
   },
   "progress": {
    "current_stop_sequence": 5,
    "current_stop_id": "4181",
    "current_status": "STOPPED_AT"
   },
   "adherence": {
    "state": "ontime",
    "seconds": 42,
    "glyph": "circle",
    "against": {
     "stop_id": "4181",
     "stop_name": "7th/Northwestern",
     "stop_sequence": 5,
     "scheduled_at": 1787152149,
     "predicted_at": 1787152191
    },
    "reason": null
   },
   "pattern": {
    "is_baseline": true,
    "is_special": false,
    "trips_in_pattern": 268,
    "adds": [],
    "skips": []
   },
   "block": {
    "block_id": "4001",
    "confidence": "low",
    "next_trip": {
     "trip_id": "3005612_15783",
     "direction_id": 0,
     "start_time": "10:25:00",
     "start_epoch": 1787153100,
     "start_stop_id": "1368",
     "start_stop_name": "Pleasant Valley/5th",
     "is_direction_flip": false
    }
   }
  },
  {
   "vehicle_id": "2858",
   "label": "2858",
   "position": {
    "lat": 30.26257,
    "lon": -97.722305,
    "bearing": null,
    "speed_mps": 0.044704
   },
   "position_at": 1787152236,
   "in_service": true,
   "route_id": "4",
   "route_short_name": "4",
   "trip": {
    "trip_id": "3014768_15201",
    "start_time": "09:49:00",
    "start_epoch": 1787150940,
    "direction_id": 1,
    "headsign": "4 Shady EB",
    "schedule_relationship": "SCHEDULED"
   },
   "progress": {
    "current_stop_sequence": 15,
    "current_stop_id": "934",
    "current_status": "STOPPED_AT"
   },
   "adherence": {
    "state": "ontime",
    "seconds": -45,
    "glyph": "circle",
    "against": {
     "stop_id": "934",
     "stop_name": "Chicon/East 7th",
     "stop_sequence": 15,
     "scheduled_at": 1787152263,
     "predicted_at": 1787152218
    },
    "reason": null
   },
   "pattern": {
    "is_baseline": true,
    "is_special": false,
    "trips_in_pattern": 397,
    "adds": [],
    "skips": []
   },
   "block": {
    "block_id": "4002",
    "confidence": "low",
    "next_trip": {
     "trip_id": "3005613_15782",
     "direction_id": 0,
     "start_time": "09:55:00",
     "start_epoch": 1787151300,
     "start_stop_id": "1368",
     "start_stop_name": "Pleasant Valley/5th",
     "is_direction_flip": true
    }
   }
  },
  {
   "vehicle_id": "2867",
   "label": "2867",
   "position": {
    "lat": 30.271435,
    "lon": -97.75368,
    "bearing": null,
    "speed_mps": 0.312928
   },
   "position_at": 1787152235,
   "in_service": true,
   "route_id": "4",
   "route_short_name": "4",
   "trip": {
    "trip_id": "3014706_15608",
    "start_time": "09:49:00",
    "start_epoch": 1787150940,
    "direction_id": 0,
    "headsign": "4 Mopac WB",
    "schedule_relationship": "SCHEDULED"
   },
   "progress": {
    "current_stop_sequence": 14,
    "current_stop_id": "1972",
    "current_status": "IN_TRANSIT_TO"
   },
   "adherence": {
    "state": "ontime",
    "seconds": 35,
    "glyph": "circle",
    "against": {
     "stop_id": "1972",
     "stop_name": "6th/Harthan",
     "stop_sequence": 14,
     "scheduled_at": 1787152257,
     "predicted_at": 1787152292
    },
    "reason": null
   },
   "pattern": {
    "is_baseline": true,
    "is_special": false,
    "trips_in_pattern": 268,
    "adds": [],
    "skips": []
   },
   "block": {
    "block_id": "1010",
    "confidence": "high",
    "next_trip": {
     "trip_id": "3014770_15088",
     "direction_id": 1,
     "start_time": "10:21:00",
     "start_epoch": 1787152860,
     "start_stop_id": "6243",
     "start_stop_name": "Campbell/5th",
     "is_direction_flip": true
    }
   }
  },
  {
   "vehicle_id": "2641",
   "label": "2641",
   "position": {
    "lat": 30.257483,
    "lon": -97.71062,
    "bearing": null,
    "speed_mps": 0.0
   },
   "position_at": 1787152236,
   "in_service": true,
   "route_id": "4",
   "route_short_name": "4",
   "trip": {
    "trip_id": "3014708_15610",
    "start_time": "10:21:00",
    "start_epoch": 1787152860,
    "direction_id": 0,
    "headsign": "4 Mopac WB",
    "schedule_relationship": "SCHEDULED"
   },
   "progress": {
    "current_stop_sequence": 1,
    "current_stop_id": "1368",
    "current_status": "STOPPED_AT"
   },
   "adherence": {
    "state": "ontime",
    "seconds": 0,
    "glyph": "circle",
    "against": {
     "stop_id": "1368",
     "stop_name": "Pleasant Valley/5th",
     "stop_sequence": 1,
     "scheduled_at": 1787152860,
     "predicted_at": 1787152860
    },
    "reason": null
   },
   "pattern": {
    "is_baseline": true,
    "is_special": false,
    "trips_in_pattern": 268,
    "adds": [],
    "skips": []
   },
   "block": {
    "block_id": "4003",
    "confidence": "high",
    "next_trip": {
     "trip_id": "3014772_15090",
     "direction_id": 1,
     "start_time": "10:53:00",
     "start_epoch": 1787154780,
     "start_stop_id": "6243",
     "start_stop_name": "Campbell/5th",
     "is_direction_flip": true
    }
   }
  },
  {
   "vehicle_id": "2305",
   "label": "2305",
   "position": {
    "lat": 30.256681,
    "lon": -97.70781,
    "bearing": null,
    "speed_mps": 0.1536242
   },
   "position_at": 1787152229,
   "in_service": false,
   "route_id": "4",
   "route_short_name": "4",
   "adherence": {
    "state": "deadhead",
    "seconds": null,
    "glyph": "ring",
    "against": null,
    "reason": null
   }
  }
 ],
 "timepoints": [
  {
   "stop_id": "1368",
   "stop_name": "Pleasant Valley/5th",
   "stop_name_full": "501 Pleasant Valley/5th",
   "stop_sequence": 1,
   "direction_id": 0,
   "lat": 30.257443,
   "lon": -97.710596,
   "service_status": {
    "served": true,
    "source": null,
    "detail": null
   },
   "minor_stops": [
    {
     "stop_id": "3337",
     "stop_name": "7th/Pleasant Valley",
     "stop_sequence": 2,
     "lat": 30.260388,
     "lon": -97.710078,
     "service_status": {
      "served": true,
      "source": null,
      "detail": null
     }
    },
    {
     "stop_id": "847",
     "stop_name": "7th/Calles",
     "stop_sequence": 3,
     "lat": 30.260665,
     "lon": -97.711521,
     "service_status": {
      "served": true,
      "source": null,
      "detail": null
     }
    },
    {
     "stop_id": "848",
     "stop_name": "7th/Pedernales",
     "stop_sequence": 4,
     "lat": 30.260963,
     "lon": -97.71356,
     "service_status": {
      "served": true,
      "source": null,
      "detail": null
     }
    },
    {
     "stop_id": "4181",
     "stop_name": "7th/Northwestern",
     "stop_sequence": 5,
     "lat": 30.261408,
     "lon": -97.716495,
     "service_status": {
      "served": true,
      "source": null,
      "detail": null
     }
    },
    {
     "stop_id": "5119",
     "stop_name": "7th/Chicon",
     "stop_sequence": 6,
     "lat": 30.262602,
     "lon": -97.721983,
     "service_status": {
      "served": true,
      "source": null,
      "detail": null
     }
    },
    {
     "stop_id": "5120",
     "stop_name": "7th/Concho",
     "stop_sequence": 7,
     "lat": 30.26388,
     "lon": -97.725646,
     "service_status": {
      "served": true,
      "source": null,
      "detail": null
     }
    },
    {
     "stop_id": "6460",
     "stop_name": "7th/Waller",
     "stop_sequence": 8,
     "lat": 30.265561,
     "lon": -97.7305,
     "service_status": {
      "served": true,
      "source": null,
      "detail": null
     }
    },
    {
     "stop_id": "5949",
     "stop_name": "8th/Trinity",
     "stop_sequence": 9,
     "lat": 30.268997,
     "lon": -97.738479,
     "service_status": {
      "served": true,
      "source": null,
      "detail": null
     }
    }
   ]
  },
  {
   "stop_id": "5937",
   "stop_name": "8th/Congress",
   "stop_name_full": "104 8th/Congress",
   "stop_sequence": 10,
   "direction_id": 0,
   "lat": 30.269914,
   "lon": -97.741869,
   "service_status": {
    "served": true,
    "source": null,
    "detail": null
   },
   "minor_stops": [
    {
     "stop_id": "5938",
     "stop_name": "8Th/Lavaca",
     "stop_sequence": 11,
     "lat": 30.270613,
     "lon": -97.744215,
     "service_status": {
      "served": true,
      "source": null,
      "detail": null
     }
    },
    {
     "stop_id": "5499",
     "stop_name": "6th/West",
     "stop_sequence": 12,
     "lat": 30.270316,
     "lon": -97.75049,
     "service_status": {
      "served": true,
      "source": null,
      "detail": null
     }
    },
    {
     "stop_id": "1970",
     "stop_name": "6th/Wood",
     "stop_sequence": 13,
     "lat": 30.270962,
     "lon": -97.752215,
     "service_status": {
      "served": true,
      "source": null,
      "detail": null
     }
    },
    {
     "stop_id": "1972",
     "stop_name": "6th/Harthan",
     "stop_sequence": 14,
     "lat": 30.273061,
     "lon": -97.757846,
     "service_status": {
      "served": true,
      "source": null,
      "detail": null
     }
    },
    {
     "stop_id": "1973",
     "stop_name": "6th/Pressler",
     "stop_sequence": 15,
     "lat": 30.273935,
     "lon": -97.760118,
     "service_status": {
      "served": true,
      "source": null,
      "detail": null
     }
    },
    {
     "stop_id": "1974",
     "stop_name": "6th/West Lynn",
     "stop_sequence": 16,
     "lat": 30.274836,
     "lon": -97.762509,
     "service_status": {
      "served": true,
      "source": null,
      "detail": null
     }
    }
   ]
  },
  {
   "stop_id": "6243",
   "stop_name": "Campbell/5th",
   "stop_name_full": "504 Campbell/5th",
   "stop_sequence": 17,
   "direction_id": 0,
   "lat": 30.275026,
   "lon": -97.764825,
   "service_status": {
    "served": true,
    "source": null,
    "detail": null
   },
   "minor_stops": []
  }
 ],
 "alerts": [
  {
   "id": "fc3c62c6-9c81-4c1c-a1a2-033e98c12672",
   "effect": "NO_SERVICE",
   "cause": "CONSTRUCTION",
   "header": "Stop Closure on Routes 4 and 485",
   "description": "On Routes 4 and 485, stop 3535 7th/Springdale (ID 940) will be closed due to construction.",
   "url": "https://www.capmetro.org/alerts",
   "active_from": 1781376960,
   "active_until": null,
   "stop_ids": [
    "940",
    "940"
   ],
   "severity": "high"
  },
  {
   "id": "3e910735-d3b8-40dd-8a8c-c5e398a1c27f",
   "effect": "NO_SERVICE",
   "cause": "UNKNOWN_CAUSE",
   "header": "Stop Closure on Routes 4 and 663",
   "description": "On Routes 4 and 663, stop 416 6th/San Antonio (ID 1967) will be closed.",
   "url": "https://www.capmetro.org/alerts",
   "active_from": 1780601040,
   "active_until": null,
   "stop_ids": [
    "1967",
    "1967"
   ],
   "severity": "high"
  },
  {
   "id": "13e6b8da-789f-45cb-86f6-09cb3f2fbc4f",
   "effect": "NO_SERVICE",
   "cause": "CONSTRUCTION",
   "header": "Stop Closure on Routes 4 and 663",
   "description": "On Routes 4 and 663, stop 6th/Baylor (ID 1971) will be closed due to construction.",
   "url": "https://www.capmetro.org/alerts",
   "active_from": 1745865480,
   "active_until": null,
   "stop_ids": [
    "1971",
    "1971"
   ],
   "severity": "high"
  }
 ]
};
