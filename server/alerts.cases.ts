// server/alerts.cases.ts
// Known emergencies for server/alerts.cases.test.ts: what each aircraft sent, from published figures (src). Times are UTC clock
// times of `day` ('24:10:00' is ten past midnight of the next); altitudes are barometric, ft. `want` is what the alerts find
// today: a change of the rules that changes a line here is a decision, not a side effect.

export interface Case {
  name: string // the flight and its date
  what: string // what happened, in a few words
  callsign: string
  type: string // ICAO type designator
  cat?: string // ADS-B emitter category; default A3
  day: string // the UTC day, 'YYYY-MM-DD'
  alt: [string, number][] // [time, ft]: the published points, straight lines between; level before the first and after the last
  end: string // its last message received (impact, landing, out of reach, transponder off)
  sqk?: [string, string][] // [time, code]: the squawk it sends from then on; before the first, an ordinary one
  deaf?: [string, string][] // [from, to): spans in which no receiver of the open networks heard it
  want: { sweep: string | null; late: string | null; onMap: string | null } // 'squawk 7700', 'descent' (D1), 'dive' (D2), null: not found
  src: string
}

export const CASES: Case[] = [
  {
    name: 'flydubai FZ1073, 2026-09-30',
    what: 'dive from FL340 over Saudi Arabia, lost for 9 min, then 7700 and 7500',
    callsign: 'FDB1073', type: 'B38M', day: '2026-09-30',
    alt: [
      ['05:21:00', 34_000], ['05:21:10', 33_950], ['05:21:20', 33_375], ['05:21:30', 33_075], ['05:21:40', 32_850], ['05:22:10', 27_950],
      ['05:22:40', 16_600], ['05:23:23', 21_725], ['05:24:18', 14_950], ['05:27:05', 13_675], ['05:31:26', 15_000],
    ],
    end: '05:53:32', deaf: [['05:22:13', '05:31:26']], sqk: [['05:23:20', '7700'], ['05:35:17', '7500']],
    want: { sweep: 'squawk 7700', late: 'dive', onMap: 'squawk 7700' },
    src: 'adsb.lol trace and half-hour file (public/scenarios/fz1073, descent.test.ts FZ1073_FILE)',
  },

  // Declared emergencies: the crew set an emergency code.
  {
    name: 'Ryanair FR4978, 2021-05-23',
    what: 'false bomb threat, 7700, diverted to Minsk',
    callsign: 'RYR1TZ', type: 'B738', day: '2021-05-23',
    alt: [['09:47:34', 39_000], ['10:04:00', 6000]],
    end: '10:15:00', sqk: [['09:47:34', '7700']],
    want: { sweep: 'squawk 7700', late: 'squawk 7700', onMap: 'squawk 7700' },
    src: 'ICAO fact-finding report (7700 selected at 09:47:34 UTC); Flightradar24 blog',
  },
  {
    name: 'Aeroflot SU1492, 2019-05-05',
    what: 'lightning strike, 7600 then 7700, burned on landing at Moscow',
    callsign: 'AFL1492', type: 'SU95', day: '2019-05-05',
    alt: [['15:08:11', 8900], ['15:10:00', 10_600], ['15:30:00', 600]],
    end: '15:30:00', sqk: [['15:09:32', '7600'], ['15:26:31', '7700']],
    want: { sweep: 'squawk 7600', late: 'squawk 7700', onMap: 'squawk 7600' },
    src: 'Interstate Aviation Committee interim report (7600 at 15:09:32, 7700 at 15:26:31 UTC)',
  },
  {
    name: 'Air Astana KC1388, 2018-11-11',
    what: 'reversed aileron cables, loss of control for 90 min, 7600 then 7700',
    callsign: 'KZR1388', type: 'E190', day: '2018-11-11',
    alt: [['13:36:00', 10_000]], // no altitudes are published as figures; none of the rules needs them here
    end: '15:26:00', sqk: [['13:36:00', '7600'], ['14:01:00', '7700']],
    want: { sweep: 'squawk 7600', late: 'squawk 7600', onMap: 'squawk 7600' },
    src: 'GPIAAF notice; aviation24.be (7600 five minutes after the 13:31 take-off, 7700 at 14:01 UTC)',
  },
  {
    name: 'Azerbaijan Airlines J2-8243, 2024-12-25',
    what: 'hit near Grozny, controls lost, 7700 for 53 min, crashed at Aktau',
    callsign: 'AHY8243', type: 'E190', day: '2024-12-25',
    alt: [['05:13:30', 3500], ['05:20:00', 6000]], // its swings of altitude are published only as a chart
    end: '06:28:00', sqk: [['05:35:00', '7700']],
    want: { sweep: 'squawk 7700', late: 'squawk 7700', onMap: 'squawk 7700' },
    src: 'Kazakh preliminary report; Interfax (7700 at 05:35 UTC); Flightradar24 blog',
  },
  {
    name: 'Sichuan Airlines 3U8633, 2018-05-13',
    what: 'windshield blew out at FL321, 7700, rapid descent to 24,000 ft',
    callsign: 'CSC8633', type: 'A319', day: '2018-05-13',
    alt: [['23:08:00', 32_000], ['23:11:00', 24_000], ['23:22:36', 15_750]],
    end: '23:41:05', sqk: [['23:10:39', '7700']],
    want: { sweep: 'squawk 7700', late: 'squawk 7700', onMap: 'squawk 7700' },
    src: 'CAAC report SWCAAC-SIR-2018-1 (7700 on radar at 23:10:39 UTC); Flightradar24',
  },

  {
    name: 'Ural Airlines U61383, 2023-09-12',
    what: 'hydraulic failure, 7700 at FL180, landed in a field near Novosibirsk',
    callsign: 'SVR1383', type: 'A320', day: '2023-09-12',
    alt: [['02:26:00', 18_000], ['02:45:00', 500]],
    end: '02:45:00', sqk: [['02:26:00', '7700']],
    want: { sweep: 'squawk 7700', late: 'squawk 7700', onMap: 'squawk 7700' },
    src: 'The Aviation Herald (the ADS-B emergency signal from 02:26 UTC, read from its "05:26Z"; landed 02:45 UTC)',
  },

  // Emergency descents and upsets with no emergency code reported (or one sent only briefly: the replay sends none).
  {
    name: 'Southwest WN1380, 2018-04-17',
    what: 'engine failure and a broken window at FL320, emergency descent, no 7700 reported',
    callsign: 'SWA1380', type: 'B737', day: '2018-04-17',
    alt: [['15:03:33', 32_650], ['15:04:54', 28_500], ['15:05:02', 28_000], ['15:08:12', 17_000], ['15:09:30', 13_600], ['15:10:10', 12_000], ['15:11:46', 10_000]],
    end: '15:20:30',
    want: { sweep: null, late: null, onMap: null },
    src: 'NTSB AAR-19/03 (FDR: peak descent 5,228 fpm; no squawk is reported)',
  },
  {
    name: 'Alaska AS1282, 2024-01-06',
    what: 'door plug blew out at 14,800 ft, returned to Portland, no 7700',
    callsign: 'ASA1282', type: 'B39M', day: '2024-01-06',
    alt: [['01:10:29', 10_000], ['01:12:33', 14_830], ['01:13:41', 16_320], ['01:17:02', 10_000]],
    end: '01:26:00',
    want: { sweep: null, late: null, onMap: null },
    src: 'NTSB preliminary report; Flightradar24 blog (the crew did not squawk 7700)',
  },
  {
    name: 'Singapore SQ321, 2024-05-21',
    what: 'severe turbulence at FL370 (178 ft in 4.6 s), diverted to Bangkok; no squawk is reported',
    callsign: 'SIA321', type: 'B77W', cat: 'A5', day: '2024-05-21',
    alt: [['07:49:21', 37_000], ['07:49:40', 37_360], ['07:49:45', 37_185], ['07:50:23', 37_000], ['08:06:51', 37_000], ['08:10:00', 31_000]],
    end: '08:45:12',
    want: { sweep: null, late: null, onMap: null },
    src: 'TSIB preliminary findings (FDR); Flightradar24 blog',
  },
  {
    name: 'Ryanair FR7312, 2018-07-13',
    what: 'decompression at FL370, emergency descent to 9,500 ft in 8 min; 7700 only briefly',
    callsign: 'RYR7312', type: 'B738', day: '2018-07-13',
    alt: [['20:43:30', 37_000], ['20:44:31', 36_700], ['20:46:29', 27_400], ['20:48:07', 19_000], ['20:49:15', 15_600], ['20:52:05', 9900], ['20:52:15', 9500]],
    end: '21:19:00',
    want: { sweep: null, late: null, onMap: null },
    src: 'BFU report (radar altitudes; the steepest stretch is 5,140 fpm)',
  },
  {
    name: 'Air China CA106, 2018-07-10',
    what: 'both air supplies switched off, descent from FL350 to 10,000 ft in 12 min; no code reported',
    callsign: 'CCA106', type: 'B738', day: '2018-07-10',
    alt: [['11:38:19', 35_025], ['11:49:51', 10_050], ['11:56:53', 14_825], ['12:00:32', 16_725], ['12:07:13', 24_600]],
    end: '12:44:36',
    want: { sweep: null, late: null, onMap: null },
    src: 'The Aviation Herald; the times are a reader\'s reading of the track',
  },
  {
    name: 'Air France AF66, 2017-09-30',
    what: 'A380 engine fan broke up at FL370 over Greenland, stepped down to FL270; no code reported',
    callsign: 'AFR066', type: 'A388', cat: 'A5', day: '2017-09-30',
    alt: [['13:50:48', 37_000], ['13:56:53', 33_000], ['14:15:00', 27_000]],
    end: '15:42:16',
    want: { sweep: null, late: null, onMap: null },
    src: 'BEA final report (mayday by voice and datalink; beyond radar there)',
  },
  {
    name: 'Swiss LX1885, 2024-12-23',
    what: 'engine failure and smoke at FL400, on the runway at Graz 18 min later; no code reported',
    callsign: 'SWR1885', type: 'BCS3', day: '2024-12-23',
    alt: [['16:34:51', 40_000], ['16:53:10', 1100]],
    end: '16:53:10',
    want: { sweep: null, late: null, onMap: null },
    src: 'Austrian SUB preliminary report (mayday by radio at 16:34:51 UTC)',
  },
  {
    name: 'LATAM LA800, 2024-03-11',
    what: 'pilot seat pushed the controls at FL410, about 400 ft lost in seconds; no 7700',
    callsign: 'LAN800', type: 'B789', cat: 'A5', day: '2024-03-11',
    alt: [['02:30:00', 41_000], ['02:30:05', 40_600], ['02:30:40', 41_000]], // the minute is not published: before 02:39 UTC
    end: '03:26:00',
    want: { sweep: null, late: null, onMap: null },
    src: 'Chilean DGAC, by the press; Simple Flying (the crew never squawked 7700)',
  },

  // Loss of control at altitude, no emergency code.
  {
    name: 'China Eastern MU5735, 2022-03-21',
    what: 'dived from FL291 to 7,400 ft in under a minute, recovered briefly, dived again',
    callsign: 'CES5735', type: 'B738', day: '2022-03-21',
    alt: [['06:20:59', 29_100], ['06:21:46', 7850], ['06:21:50', 7425], ['06:22:05', 8600], ['06:22:22', 8175], ['06:22:35', 3225]],
    end: '06:22:35',
    want: { sweep: null, late: 'descent', onMap: 'descent' },
    src: 'Flightradar24 (29,100 ft at 06:20:59, 7,425 ft, 8,600 ft, last 3,225 ft at 06:22:35 UTC; the times between are a third party\'s reading of its data)',
  },
  {
    name: 'Voepass 2283, 2024-08-09',
    what: 'ATR 72 in icing at FL170, flat spin to the ground in about 70 s',
    callsign: 'PTB2283', type: 'AT75', cat: 'A2', day: '2024-08-09',
    // The altitudes after 16:21:22 are not published as figures: these follow from the published rates (−9,020 fpm at 16:21:54, −24,064 fpm at 16:22:08).
    alt: [['16:21:02', 17_000], ['16:21:10', 16_750], ['16:21:22', 17_200], ['16:21:54', 14_800], ['16:22:08', 10_950], ['16:22:31', 3250]],
    end: '16:22:31',
    want: { sweep: null, late: 'descent', onMap: 'descent' },
    src: 'Flightradar24 blog (data for 89 s from 16:21:02 UTC); AirNav Radar',
  },
  {
    name: 'Cessna Citation N611VG, 2023-06-04',
    what: 'pilot unresponsive at FL340 for two hours, then a spiral dive into Virginia',
    callsign: 'N611VG', type: 'C560', cat: 'A2', day: '2023-06-04',
    alt: [['19:22:14', 34_000], ['19:23:35', 3000]], // the seconds are from a forum's reading of the track, the NTSB gives minutes
    end: '19:23:35',
    want: { sweep: null, late: 'descent', onMap: 'descent' },
    src: 'NTSB (level at 34,000 ft until 19:22, impact 19:23 UTC)',
  },
  {
    name: 'Metrojet 7K9268, 2015-10-31',
    what: 'bomb at 30,900 ft over Sinai; about 3,000 ft lost in 14 s of data, then silence',
    callsign: 'KGL9268', type: 'A321', day: '2015-10-31',
    alt: [['04:12:53', 30_875], ['04:13:08', 30_825], ['04:13:11', 29_925], ['04:13:16', 28_375], ['04:13:22', 27_925]],
    end: '04:13:22', // the altitudes published end here; three receivers heard it for 17 s more
    want: { sweep: null, late: 'dive', onMap: null },
    src: 'Flightradar24 blog table (it never received a 7700)',
  },
  {
    name: 'Germanwings 4U9525, 2015-03-24',
    what: 'flown down from FL380 into the Alps at about 3,500 fpm for ten minutes',
    callsign: 'GWI18G', type: 'A320', day: '2015-03-24',
    alt: [['09:30:56', 38_000], ['09:31:21', 37_700], ['09:34:24', 28_050], ['09:34:40', 26_875], ['09:36:15', 20_350], ['09:38:17', 13_700], ['09:40:00', 6800]],
    end: '09:40:00',
    want: { sweep: null, late: null, onMap: null },
    src: 'Flightradar24 (last signal 6,800 ft at 09:40 UTC); BEA final report (1,700 to 5,000 fpm)',
  },
  {
    name: 'Cessna 551 OE-FGR, 2022-09-04',
    what: 'pilot unresponsive at FL360 from Spain to the Baltic, slow spiral into the sea',
    callsign: 'OEFGR', type: 'C551', cat: 'A1', day: '2022-09-04',
    alt: [['17:30:00', 36_000], ['17:36:00', 27_500], ['17:40:00', 20_000], ['17:44:30', 2100]],
    end: '17:44:30',
    want: { sweep: null, late: null, onMap: null },
    src: 'BFU interim report; Flightradar24 (last 2,100 ft at −8,000 fpm)',
  },

  // The transponder stopped, or no receiver heard the fall.
  {
    name: 'Indonesia AirAsia QZ8501, 2014-12-27',
    what: 'stalled from 38,500 ft over the Java Sea; receivers had lost it level at FL320',
    callsign: 'AWQ8501', type: 'A320', day: '2014-12-27',
    alt: [['23:10:00', 32_000]],
    end: '23:17:00',
    want: { sweep: null, late: null, onMap: null },
    src: 'Flightradar24 (signal lost at 32,000 ft); KNKT final report',
  },
  {
    name: 'EgyptAir MS804, 2016-05-19',
    what: 'lost over the Mediterranean; ADS-B ended level at 36,975 ft',
    callsign: 'MSR804', type: 'A320', day: '2016-05-19',
    alt: [['00:20:00', 36_975]],
    end: '00:29:00',
    want: { sweep: null, late: null, onMap: null },
    src: 'Flightradar24 (data until 00:29 UTC)',
  },
  {
    name: 'Malaysia MH17, 2014-07-17',
    what: 'shot down at FL330; ADS-B ended level at 33,000 ft',
    callsign: 'MAS17', type: 'B772', cat: 'A5', day: '2014-07-17',
    alt: [['13:15:00', 33_000]],
    end: '13:21:28',
    want: { sweep: null, late: null, onMap: null },
    src: 'Flightradar24 (last position 13:21:28 UTC at 33,000 ft); Dutch Safety Board',
  },

  // Accidents at low level, at take-off or on approach: no emergency code, and no fall from a height.
  {
    name: 'Sriwijaya Air SJ182, 2021-01-09',
    what: 'rolled and dived from 10,900 ft into the Java Sea in 21 s',
    callsign: 'SJY182', type: 'B735', day: '2021-01-09',
    alt: [['07:39:00', 9000], ['07:40:06', 10_900], ['07:40:27', 250]],
    end: '07:40:27',
    want: { sweep: null, late: 'dive', onMap: 'descent' },
    src: 'Flightradar24 (10,900 ft at 07:40:06, 250 ft at 07:40:27 UTC); KNKT final report',
  },
  {
    name: 'Lion Air JT610, 2018-10-28',
    what: 'MCAS; six minutes near 5,400 ft, then about 5,000 ft lost in 23 s into the Java Sea',
    callsign: 'LNI610', type: 'B38M', day: '2018-10-28',
    alt: [['23:25:00', 5400], ['23:31:33', 5000], ['23:31:56', 425]],
    end: '23:31:56',
    want: { sweep: null, late: 'dive', onMap: null },
    src: 'Flightradar24 (last signal 23:31:56 UTC at 425 ft); KNKT final report (no emergency declared)',
  },
  {
    name: 'Ethiopian ET302, 2019-03-10',
    what: 'MCAS; receivers lost it climbing through 8,600 ft, three minutes before the dive',
    callsign: 'ETH302', type: 'B38M', day: '2019-03-10',
    alt: [['05:38:18', 7700], ['05:41:02', 8600]],
    end: '05:41:02',
    want: { sweep: null, late: null, onMap: null },
    src: 'Flightradar24 (last position 05:41:02 UTC); The Aviation Herald (the code stayed 2000)',
  },
  {
    name: 'Air India AI171, 2025-06-12',
    what: 'both engines cut off at lift-off; reached 625 ft, crashed 30 s later',
    callsign: 'AIC171', type: 'B788', cat: 'A5', day: '2025-06-12',
    alt: [['08:08:39', 190], ['08:08:46', 625], ['08:08:51', 575]],
    end: '08:08:51',
    want: { sweep: null, late: null, onMap: null },
    src: 'Flightradar24 (625 ft at 08:08:46, last frame 08:08:51 UTC); AAIB India preliminary report',
  },
  {
    name: 'Jeju Air 7C2216, 2024-12-28',
    what: 'bird strike on approach to Muan; ADS-B stopped at 500 ft, four minutes before the belly landing',
    callsign: 'JJA2216', type: 'B738', day: '2024-12-28',
    alt: [['23:55:00', 2000], ['23:58:50', 500]],
    end: '23:58:50',
    want: { sweep: null, late: null, onMap: null },
    src: 'Flightradar24 (last message 23:58:50 UTC at 500 ft); ARAIB preliminary report',
  },
  {
    name: 'Ukraine International PS752, 2020-01-08',
    what: 'shot down climbing through 8,100 ft; the transponder stopped at the first missile',
    callsign: 'AUI752', type: 'B738', day: '2020-01-08',
    alt: [['02:42:19', 3300], ['02:44:56', 8100]],
    end: '02:44:57',
    want: { sweep: null, late: null, onMap: null },
    src: 'Iran AAIB final report; Flightradar24 (last ADS-B 02:44:57 UTC)',
  },
  {
    name: 'PSA / American AA5342, 2025-01-30',
    what: 'mid-air collision with a helicopter at 325 ft on final approach to Washington',
    callsign: 'JIA5342', type: 'CRJ7', day: '2025-01-30',
    alt: [['01:44:00', 2000], ['01:47:59', 325]],
    end: '01:48:03',
    want: { sweep: null, late: null, onMap: null },
    src: 'NTSB; Flightradar24 (last position 01:48:03 UTC)',
  },
  {
    name: 'Pakistan International PK8303, 2020-05-22',
    what: 'gear-up touchdown, go-around, both engines failed, crashed short of Karachi',
    callsign: 'PIA8303', type: 'A320', day: '2020-05-22',
    alt: [['09:34:25', 25], ['09:37:02', 1900], ['09:37:21', 1800], ['09:39:12', 1500], ['09:39:42', 700], ['09:39:49', 600], ['09:40:07', 400]],
    end: '09:40:07',
    want: { sweep: null, late: null, onMap: null },
    src: 'Pakistan AAIB final report (radar altitudes; mayday by radio at 09:39:46 UTC, no code reported)',
  },
  {
    name: 'Yeti Airlines YT691, 2023-01-15',
    what: 'propellers feathered on approach to Pokhara, stalled at 300 ft above the ground',
    callsign: 'NYT691', type: 'AT72', cat: 'A2', day: '2023-01-15',
    alt: [['05:05:00', 2875]], // its transponder sent wrong altitudes; the last one published is this
    end: '05:12:00',
    want: { sweep: null, late: null, onMap: null },
    src: 'Flightradar24 (last signal 05:12 UTC at 2,875 ft; the field is at 2,700 ft)',
  },
]
