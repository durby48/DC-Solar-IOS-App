-- RADAR HAIL SWATHS (2026-10-12, Devon) — the storm overhaul.
--
-- Storms used to come from NOAA SPC spotter REPORTS (points) with a 3-mile
-- circle around each. Now they come from NOAA MRMS radar: MESH, the Maximum
-- Estimated Size of Hail, a ~1 km grid every 2 minutes, which is what the
-- commercial hail maps are built on. The storm-sync edge function decodes the
-- GRIB2 files from the public AWS bucket noaa-mrms-pds (crop around KC only),
-- contours the grid into SWATHS at hail-size steps, and hands them to
-- hail_store_swaths() below:
--   live   every 30 min, today's swath = running max of MESH_Max_60min files
--   final  once a day, the Central day from the MESH_Max_1440min file ending
--          at local midnight (replaces the live one)
--   backfill  final for past days (history since 2020-10-14 is on AWS)
--
-- COVERAGE (Devon): swaths are clipped to ten counties — Clay, Jackson, Cass,
-- Johnson, Lafayette and Platte in Missouri; Johnson, Douglas, Leavenworth and
-- Wyandotte in Kansas (US Census TIGERweb outlines, simplified to ~80 m).
--
-- THE RULES, unchanged in spirit: a STORM is a Central day with a swath of
-- hail ≥ storm_min_hail() (1 in); a lead / customer is HIT when its address is
-- INSIDE that swath (no more 3-mile radius); its hail size is the largest step
-- covering the address. storms / storm_hits / last_hail_* / the RPCs keep their
-- shapes, so alerts, Storm check tasks, Storm reports, CRM hail tags and filters
-- carry on — fed by radar. storm_hits.miles is 0 and last_hail_miles null for a
-- radar hit. SPC reports are still collected (map dots, ground truth) and counted
-- in storms.hail_reports when inside the coverage.
--
-- Idempotent.

begin;

create extension if not exists postgis with schema extensions;

-- ---------------------------------------------------------------------------
-- Coverage: the ten counties
-- ---------------------------------------------------------------------------
create table if not exists public.hail_coverage (
  geoid  text primary key,
  name   text not null,
  state  text not null,
  geom   extensions.geometry(MultiPolygon, 4326) not null
);
alter table public.hail_coverage enable row level security;
drop policy if exists hail_coverage_staff_select on public.hail_coverage;
create policy hail_coverage_staff_select on public.hail_coverage for select using (public.is_company_staff('dc-solar'));

insert into public.hail_coverage (geoid, name, state, geom)
select v.geoid, v.name, v.state,
       extensions.ST_Multi(extensions.ST_MakeValid(extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON(v.geo), 4326)))
  from (values
  ('20209', 'Wyandotte County', 'KS', '{"type":"MultiPolygon","coordinates":[[[[-94.7797,39.0437],[-94.6074,39.0441],[-94.6072,39.1056],[-94.6082,39.1183],[-94.6051,39.1233],[-94.5903,39.1381],[-94.5884,39.1499],[-94.5907,39.1548],[-94.5979,39.1584],[-94.6087,39.161],[-94.6111,39.1609],[-94.6155,39.1602],[-94.6239,39.1566],[-94.6355,39.1541],[-94.6506,39.1541],[-94.6558,39.1557],[-94.6592,39.1578],[-94.6614,39.1627],[-94.6592,39.1741],[-94.6616,39.1774],[-94.6691,39.1822],[-94.6739,39.1835],[-94.6782,39.1842],[-94.6888,39.1832],[-94.7055,39.1738],[-94.7141,39.1704],[-94.7236,39.169],[-94.7408,39.17],[-94.7523,39.1733],[-94.7528,39.1735],[-94.7629,39.18],[-94.7703,39.1898],[-94.7755,39.2006],[-94.7772,39.201],[-94.9002,39.2029],[-94.9014,39.1287],[-94.9083,39.1287],[-94.9088,38.9914],[-94.8884,39.0161],[-94.8884,39.0201],[-94.8905,39.0244],[-94.8911,39.0307],[-94.8872,39.0384],[-94.8836,39.0507],[-94.8777,39.0562],[-94.8724,39.0591],[-94.8633,39.0608],[-94.8438,39.0612],[-94.8033,39.0435],[-94.7797,39.0437]]]]}'),
  ('29101', 'Johnson County', 'MO', '{"type":"MultiPolygon","coordinates":[[[[-94.1213,38.8043],[-94.1228,38.7579],[-94.1251,38.7442],[-94.1294,38.6559],[-94.1164,38.6555],[-94.1197,38.5687],[-93.511,38.5562],[-93.5077,38.6298],[-93.5076,38.6359],[-93.5096,38.6358],[-93.5092,38.645],[-93.4931,38.899],[-93.4986,38.8993],[-93.4973,38.9284],[-93.8347,38.9379],[-93.8363,38.9087],[-94.1133,38.9175],[-94.1138,38.9174],[-94.1142,38.9173],[-94.116,38.871],[-94.1213,38.8043]]]]}'),
  ('20045', 'Douglas County', 'KS', '{"type":"MultiPolygon","coordinates":[[[[-95.2416,38.7387],[-95.0564,38.7386],[-95.0563,38.9821],[-95.0607,38.9856],[-95.0687,38.9871],[-95.0848,38.9824],[-95.0867,38.9802],[-95.0868,38.9743],[-95.0744,38.9644],[-95.0746,38.9621],[-95.0764,38.9599],[-95.0764,38.9598],[-95.0852,38.9538],[-95.0961,38.9563],[-95.1009,38.9562],[-95.1045,38.9591],[-95.1075,38.9667],[-95.1109,38.9693],[-95.1204,38.9702],[-95.1269,38.9677],[-95.1397,38.9694],[-95.1439,38.9716],[-95.1464,38.9724],[-95.1515,38.9763],[-95.1641,38.9816],[-95.1666,38.977],[-95.1649,38.9715],[-95.1695,38.9665],[-95.1737,38.9651],[-95.1862,38.9645],[-95.1871,39.0441],[-95.2747,39.0441],[-95.2796,39.0472],[-95.2823,39.0471],[-95.2857,39.0454],[-95.2856,39.0427],[-95.2827,39.0386],[-95.2823,39.037],[-95.284,39.0323],[-95.2854,39.0322],[-95.2851,39.033],[-95.2851,39.0358],[-95.2918,39.0415],[-95.298,39.0423],[-95.315,39.0347],[-95.3169,39.035],[-95.32,39.0344],[-95.3282,39.0317],[-95.3407,39.0317],[-95.3491,39.0329],[-95.352,39.0351],[-95.359,39.0355],[-95.3643,39.0391],[-95.3899,39.0499],[-95.4025,39.061],[-95.4194,39.0672],[-95.4298,39.0683],[-95.4307,39.0693],[-95.4424,39.0697],[-95.4567,39.0683],[-95.4824,39.0569],[-95.4917,39.0541],[-95.4972,39.0547],[-95.5002,39.0567],[-95.5019,39.0275],[-95.5002,38.9859],[-95.5007,38.7388],[-95.2416,38.7387]]]]}'),
  ('20091', 'Johnson County', 'KS', '{"type":"MultiPolygon","coordinates":[[[[-94.9088,38.9914],[-94.9138,38.9865],[-94.9201,38.9837],[-94.9218,38.9864],[-94.9163,38.9952],[-94.917,38.9988],[-94.9218,39.0023],[-94.9299,39.002],[-94.9389,38.9947],[-94.9396,38.9926],[-94.9406,38.99],[-94.9423,38.9882],[-94.9444,38.9864],[-94.9565,38.982],[-94.9623,38.9819],[-94.9649,38.9821],[-94.9716,38.9852],[-94.9804,38.9924],[-95.0141,39.0009],[-95.0218,38.9996],[-95.0261,38.9931],[-95.0236,38.9882],[-95.0249,38.983],[-95.0282,38.9786],[-95.0333,38.9755],[-95.0407,38.9742],[-95.0563,38.9821],[-95.0564,38.7386],[-94.6091,38.7381],[-94.6076,38.8276],[-94.6085,38.9793],[-94.6074,39.0441],[-94.8033,39.0435],[-94.8205,39.0502],[-94.8341,39.0578],[-94.8425,39.0609],[-94.8544,39.0613],[-94.8683,39.0601],[-94.8764,39.0571],[-94.8836,39.0507],[-94.8872,39.0384],[-94.8911,39.0307],[-94.8905,39.0244],[-94.8884,39.0201],[-94.8884,39.0161],[-94.9088,38.9914]]]]}'),
  ('29165', 'Platte County', 'MO', '{"type":"MultiPolygon","coordinates":[[[[-94.6008,39.3945],[-94.6012,39.5302],[-95.1029,39.5333],[-95.0827,39.5167],[-95.0593,39.5065],[-95.0545,39.5027],[-95.0506,39.4975],[-95.0477,39.4775],[-95.0447,39.4713],[-95.0375,39.4637],[-95.0334,39.4609],[-95.0285,39.4583],[-95.0158,39.4531],[-95.0002,39.4498],[-94.9902,39.4462],[-94.9821,39.4406],[-94.9788,39.4362],[-94.9766,39.4267],[-94.9729,39.4217],[-94.9645,39.4167],[-94.9548,39.4138],[-94.9479,39.4086],[-94.9463,39.4057],[-94.9456,39.3939],[-94.9397,39.3879],[-94.9306,39.3851],[-94.9192,39.3852],[-94.8979,39.3936],[-94.8918,39.3933],[-94.885,39.3898],[-94.8793,39.3798],[-94.8791,39.3775],[-94.8791,39.3757],[-94.8814,39.3704],[-94.8871,39.3654],[-94.9025,39.3604],[-94.9083,39.3556],[-94.9103,39.3513],[-94.9068,39.3174],[-94.9007,39.3019],[-94.8949,39.2944],[-94.8841,39.2845],[-94.8463,39.2685],[-94.832,39.257],[-94.8275,39.2499],[-94.8257,39.2417],[-94.8278,39.234],[-94.8349,39.2238],[-94.8347,39.2208],[-94.8317,39.2159],[-94.8219,39.2097],[-94.8115,39.2069],[-94.8026,39.2062],[-94.7891,39.2078],[-94.7829,39.2072],[-94.7764,39.2018],[-94.7703,39.1898],[-94.7629,39.18],[-94.7528,39.1735],[-94.7484,39.1721],[-94.7357,39.1692],[-94.7236,39.169],[-94.7141,39.1704],[-94.7055,39.1738],[-94.6888,39.1832],[-94.6782,39.1842],[-94.6739,39.1835],[-94.6691,39.1822],[-94.6616,39.1774],[-94.6592,39.1741],[-94.6614,39.1627],[-94.6592,39.1578],[-94.6558,39.1557],[-94.6506,39.1541],[-94.6493,39.154],[-94.6398,39.1537],[-94.6355,39.1541],[-94.6239,39.1566],[-94.6111,39.1609],[-94.6017,39.1596],[-94.6004,39.2865],[-94.6008,39.3945]]]]}'),
  ('29095', 'Jackson County', 'MO', '{"type":"MultiPolygon","coordinates":[[[[-94.2177,39.2084],[-94.2296,39.2154],[-94.2399,39.2295],[-94.2501,39.2349],[-94.2554,39.2362],[-94.2674,39.2354],[-94.2908,39.2369],[-94.3046,39.2314],[-94.3132,39.2223],[-94.3172,39.2147],[-94.3194,39.2046],[-94.3223,39.1987],[-94.3377,39.1807],[-94.3415,39.1775],[-94.3462,39.1739],[-94.3541,39.1705],[-94.3636,39.1637],[-94.3694,39.1637],[-94.3785,39.1704],[-94.3848,39.1872],[-94.3897,39.1935],[-94.3907,39.194],[-94.395,39.1963],[-94.4013,39.197],[-94.4072,39.1953],[-94.4086,39.1936],[-94.409,39.1921],[-94.3999,39.1748],[-94.4023,39.1648],[-94.418,39.1511],[-94.4235,39.1441],[-94.4258,39.1418],[-94.4304,39.138],[-94.4406,39.1308],[-94.4616,39.1204],[-94.4679,39.1249],[-94.4693,39.1307],[-94.4846,39.1455],[-94.4954,39.1504],[-94.5064,39.1509],[-94.5235,39.1488],[-94.5342,39.1459],[-94.5392,39.1427],[-94.5496,39.1309],[-94.555,39.1274],[-94.5923,39.1112],[-94.5987,39.1098],[-94.6039,39.1109],[-94.6073,39.1134],[-94.608,38.8472],[-94.5091,38.8423],[-94.2876,38.8351],[-94.1753,38.8348],[-94.1188,38.8332],[-94.114,38.9081],[-94.1143,38.9286],[-94.1107,38.9879],[-94.1048,39.1435],[-94.114,39.1497],[-94.1264,39.1658],[-94.1337,39.1712],[-94.1471,39.1752],[-94.1768,39.1781],[-94.1858,39.181],[-94.1872,39.1841],[-94.1851,39.1893],[-94.1765,39.196],[-94.1702,39.2045],[-94.1694,39.2106],[-94.1723,39.2134],[-94.1863,39.2141],[-94.2049,39.2065],[-94.2177,39.2084]]]]}'),
  ('29107', 'Lafayette County', 'MO', '{"type":"MultiPolygon","coordinates":[[[[-93.779,38.9358],[-93.4973,38.9284],[-93.4815,39.2195],[-93.4818,39.2305],[-93.4772,39.2928],[-93.4837,39.2903],[-93.492,39.2829],[-93.4959,39.2729],[-93.4962,39.2649],[-93.4942,39.2557],[-93.4866,39.2339],[-93.4879,39.2289],[-93.492,39.2235],[-93.5002,39.218],[-93.5051,39.2168],[-93.5284,39.2149],[-93.544,39.2158],[-93.5569,39.2182],[-93.5647,39.2211],[-93.5689,39.2286],[-93.5858,39.2408],[-93.5928,39.2421],[-93.6052,39.2408],[-93.6073,39.242],[-93.6275,39.243],[-93.6362,39.2471],[-93.6406,39.2473],[-93.6444,39.2452],[-93.6522,39.2483],[-93.6575,39.2455],[-93.6561,39.2412],[-93.6575,39.2388],[-93.6611,39.2374],[-93.6619,39.2358],[-93.6743,39.234],[-93.6816,39.2312],[-93.6894,39.2247],[-93.697,39.2119],[-93.7023,39.2088],[-93.7112,39.2063],[-93.7193,39.2064],[-93.739,39.2097],[-93.746,39.2095],[-93.7604,39.2066],[-93.7785,39.2006],[-93.7844,39.2002],[-93.7945,39.203],[-93.8109,39.2109],[-93.8242,39.2149],[-93.8401,39.2155],[-93.8554,39.2129],[-93.8752,39.2041],[-93.8994,39.1845],[-93.9091,39.1825],[-93.9278,39.1844],[-93.9323,39.1838],[-93.94,39.1797],[-93.9444,39.1702],[-93.9441,39.1619],[-93.9432,39.1596],[-93.9424,39.1581],[-93.9583,39.1452],[-93.9612,39.1436],[-93.967,39.1424],[-93.9791,39.1455],[-93.9889,39.1528],[-93.9867,39.1558],[-93.9863,39.1613],[-93.9834,39.1685],[-93.9679,39.1781],[-93.9654,39.1805],[-93.9626,39.1831],[-93.9615,39.1875],[-93.9614,39.1896],[-93.9618,39.1921],[-93.9668,39.1983],[-93.9774,39.2055],[-93.979,39.206],[-93.9801,39.2059],[-93.9833,39.2043],[-93.9887,39.2016],[-94.0288,39.1916],[-94.0345,39.1879],[-94.0361,39.185],[-94.0357,39.1781],[-94.0257,39.165],[-94.0242,39.1545],[-94.0481,39.1396],[-94.059,39.1348],[-94.0786,39.1343],[-94.0921,39.1372],[-94.1048,39.1435],[-94.1142,38.9173],[-93.8363,38.9087],[-93.8347,38.9379],[-93.779,38.9358]]]]}'),
  ('29047', 'Clay County', 'MO', '{"type":"MultiPolygon","coordinates":[[[[-94.4086,39.1936],[-94.4072,39.1953],[-94.4017,39.197],[-94.395,39.1963],[-94.3907,39.194],[-94.3897,39.1935],[-94.3848,39.1872],[-94.3785,39.1704],[-94.3694,39.1637],[-94.3636,39.1637],[-94.3415,39.1775],[-94.3282,39.1912],[-94.3205,39.2018],[-94.3168,39.2157],[-94.314,39.2213],[-94.3089,39.2274],[-94.3017,39.233],[-94.2899,39.2371],[-94.2674,39.2354],[-94.2554,39.2362],[-94.2501,39.2349],[-94.2433,39.232],[-94.2384,39.2282],[-94.2288,39.2146],[-94.2168,39.208],[-94.2125,39.2071],[-94.2106,39.4547],[-94.6008,39.4562],[-94.6004,39.2865],[-94.6017,39.1596],[-94.5907,39.1548],[-94.5884,39.1489],[-94.5903,39.1381],[-94.6074,39.1203],[-94.6085,39.1162],[-94.6073,39.1134],[-94.6039,39.1109],[-94.5987,39.1098],[-94.5923,39.1112],[-94.555,39.1274],[-94.5496,39.1309],[-94.5392,39.1427],[-94.5342,39.1459],[-94.5235,39.1488],[-94.5064,39.1509],[-94.4954,39.1504],[-94.4846,39.1455],[-94.4693,39.1307],[-94.4679,39.1249],[-94.4616,39.1204],[-94.4406,39.1308],[-94.4304,39.138],[-94.4258,39.1418],[-94.4235,39.1441],[-94.418,39.1511],[-94.4023,39.1648],[-94.3999,39.1748],[-94.409,39.1921],[-94.4086,39.1936]]]]}'),
  ('20103', 'Leavenworth County', 'KS', '{"type":"MultiPolygon","coordinates":[[[[-94.9087,39.0908],[-94.9083,39.1287],[-94.9014,39.1287],[-94.9002,39.2029],[-94.7755,39.2006],[-94.7829,39.2072],[-94.7891,39.2078],[-94.8026,39.2062],[-94.8115,39.2069],[-94.8219,39.2097],[-94.8317,39.2159],[-94.8347,39.2208],[-94.8349,39.2238],[-94.8278,39.234],[-94.8257,39.2417],[-94.8275,39.2499],[-94.832,39.257],[-94.8463,39.2685],[-94.8841,39.2845],[-94.8949,39.2944],[-94.9007,39.3019],[-94.9068,39.3174],[-94.9103,39.3513],[-94.9083,39.3556],[-94.9025,39.3604],[-94.8871,39.3654],[-94.8814,39.3704],[-94.8791,39.3757],[-94.8791,39.3775],[-94.8793,39.3798],[-94.885,39.3898],[-94.8918,39.3933],[-94.8979,39.3936],[-94.9192,39.3852],[-94.9306,39.3851],[-94.9372,39.3865],[-94.942,39.3895],[-94.9441,39.3916],[-94.9456,39.3939],[-94.9463,39.4057],[-94.9479,39.4086],[-94.9548,39.4138],[-94.969,39.4189],[-95.1809,39.4192],[-95.1798,39.388],[-95.1801,39.1289],[-95.188,39.1289],[-95.1862,38.9645],[-95.1737,38.9651],[-95.1695,38.9665],[-95.1649,38.9715],[-95.1666,38.977],[-95.1641,38.9816],[-95.1515,38.9763],[-95.1464,38.9724],[-95.1439,38.9716],[-95.1397,38.9694],[-95.1269,38.9677],[-95.1204,38.9702],[-95.1109,38.9693],[-95.1075,38.9667],[-95.1045,38.9591],[-95.1009,38.9562],[-95.0961,38.9563],[-95.0852,38.9538],[-95.0764,38.9598],[-95.0764,38.9599],[-95.0746,38.9621],[-95.0744,38.9644],[-95.0868,38.9743],[-95.0867,38.9802],[-95.0848,38.9824],[-95.0666,38.9871],[-95.0607,38.9856],[-95.0439,38.9751],[-95.0407,38.9742],[-95.0351,38.9749],[-95.0282,38.9786],[-95.0253,38.9823],[-95.0236,38.9882],[-95.0261,38.9931],[-95.0218,38.9996],[-95.0141,39.0009],[-94.9804,38.9924],[-94.9716,38.9852],[-94.9649,38.9821],[-94.9623,38.9819],[-94.9565,38.982],[-94.9444,38.9864],[-94.9423,38.9882],[-94.9406,38.99],[-94.9396,38.9926],[-94.9389,38.9947],[-94.9316,39.0015],[-94.9233,39.0026],[-94.9183,39.0004],[-94.9162,38.9969],[-94.9166,38.9945],[-94.9218,38.9864],[-94.9208,38.9843],[-94.9188,38.9836],[-94.9138,38.9865],[-94.9088,38.9914],[-94.9087,39.0908]]]]}'),
  ('29037', 'Cass County', 'MO', '{"type":"MultiPolygon","coordinates":[[[[-94.6087,38.7606],[-94.6116,38.6347],[-94.6129,38.4776],[-94.3122,38.4715],[-94.3139,38.4691],[-94.3108,38.4687],[-94.3113,38.4657],[-94.3068,38.4652],[-94.3052,38.4672],[-94.3038,38.4624],[-94.2981,38.4605],[-94.2975,38.4589],[-94.2932,38.4575],[-94.2933,38.4611],[-94.29,38.4598],[-94.2917,38.4632],[-94.2908,38.4656],[-94.2884,38.4643],[-94.2868,38.4611],[-94.2853,38.4609],[-94.2842,38.4627],[-94.2818,38.4589],[-94.2784,38.4584],[-94.2766,38.4566],[-94.2754,38.4569],[-94.2752,38.4589],[-94.2665,38.455],[-94.2652,38.4532],[-94.2671,38.4505],[-94.2646,38.4496],[-94.2635,38.4516],[-94.2598,38.4529],[-94.2572,38.4501],[-94.2552,38.4523],[-94.2524,38.453],[-94.2504,38.4559],[-94.2454,38.4554],[-94.2393,38.4603],[-94.2375,38.4592],[-94.2398,38.4571],[-94.2389,38.4556],[-94.2353,38.458],[-94.2272,38.4573],[-94.2268,38.4592],[-94.2259,38.4588],[-94.2251,38.4566],[-94.2289,38.4554],[-94.2264,38.4528],[-94.2295,38.4527],[-94.2259,38.4511],[-94.2249,38.4529],[-94.2229,38.4529],[-94.2233,38.4483],[-94.2179,38.4502],[-94.2166,38.4468],[-94.213,38.4484],[-94.211,38.4466],[-94.2093,38.4479],[-94.2113,38.4494],[-94.2078,38.4509],[-94.2062,38.4471],[-94.2037,38.4479],[-94.2004,38.4453],[-94.1932,38.4476],[-94.19,38.4473],[-94.1876,38.449],[-94.1896,38.4506],[-94.1862,38.449],[-94.1849,38.4461],[-94.1826,38.4461],[-94.1818,38.4479],[-94.1795,38.4456],[-94.1741,38.4455],[-94.174,38.4469],[-94.1704,38.4463],[-94.1736,38.4488],[-94.1733,38.4501],[-94.1685,38.4472],[-94.1675,38.4507],[-94.1639,38.4492],[-94.1597,38.451],[-94.1578,38.4486],[-94.1548,38.4502],[-94.1523,38.4499],[-94.1532,38.453],[-94.1521,38.4535],[-94.1483,38.4507],[-94.1341,38.4538],[-94.1183,38.4518],[-94.1169,38.4529],[-94.1108,38.4525],[-94.1082,38.4543],[-94.1088,38.456],[-94.0965,38.4549],[-94.0938,38.4586],[-94.0909,38.4559],[-94.0897,38.4524],[-94.0864,38.4559],[-94.0827,38.4531],[-94.0814,38.4496],[-94.079,38.4519],[-94.0767,38.4518],[-94.076,38.4492],[-94.0779,38.448],[-94.0742,38.4478],[-94.073,38.4492],[-94.0706,38.4467],[-94.0657,38.4471],[-94.065,38.4658],[-94.0678,38.466],[-94.0643,38.5674],[-94.1197,38.5687],[-94.1164,38.6555],[-94.1294,38.6559],[-94.1251,38.7442],[-94.1228,38.7579],[-94.1212,38.8067],[-94.1191,38.8332],[-94.1753,38.8348],[-94.2876,38.8351],[-94.5091,38.8423],[-94.608,38.8472],[-94.6087,38.7606]]]]}')
  ) as v(geoid, name, state, geo)
on conflict (geoid) do update set name = excluded.name, state = excluded.state, geom = excluded.geom;

-- ---------------------------------------------------------------------------
-- Swaths, processed days, today's running grid
-- ---------------------------------------------------------------------------
create table if not exists public.hail_swaths (
  storm_day   date not null,
  band        numeric(4, 2) not null,              -- inches: area where MESH >= band
  geom        extensions.geometry(MultiPolygon, 4326) not null,
  final       boolean not null default false,
  source      text,                                -- the MRMS file it came from
  updated_at  timestamptz not null default now(),
  primary key (storm_day, band)
);
create index if not exists hail_swaths_geom_idx on public.hail_swaths using gist (geom);
alter table public.hail_swaths enable row level security;
drop policy if exists hail_swaths_staff_select on public.hail_swaths;
create policy hail_swaths_staff_select on public.hail_swaths for select using (public.is_company_staff('dc-solar'));

-- Every Central day the radar has been checked for (hail or not).
create table if not exists public.hail_days (
  storm_day     date primary key,
  final         boolean not null default false,
  max_mesh      numeric,                           -- inches, largest anywhere in the crop
  source        text,
  processed_at  timestamptz not null default now()
);
alter table public.hail_days enable row level security;  -- service role only

-- Today's running max (live mode), one row per Central day; dropped when final.
create table if not exists public.hail_live_grids (
  storm_day   date primary key,
  width       integer not null,
  height      integer not null,
  lat0        double precision not null,
  lon0        double precision not null,
  step        double precision not null,
  cells       text not null,                       -- base64, one byte per cell = MESH in mm
  files       text[] not null default '{}',
  updated_at  timestamptz not null default now()
);
alter table public.hail_live_grids enable row level security;  -- service role only

-- ---------------------------------------------------------------------------
-- Rules + storing a day's swaths
-- ---------------------------------------------------------------------------
create or replace function public.hail_point(p_lat double precision, p_lng double precision)
returns extensions.geometry language sql immutable set search_path = public, extensions as $f$
  select ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326);
$f$;

-- The largest swath band covering a point on a day (null = none).
create or replace function public.hail_size_at(p_day date, p_lat double precision, p_lng double precision)
returns numeric language sql stable set search_path = public, extensions as $f$
  select max(s.band) from hail_swaths s
   where s.storm_day = p_day and ST_Contains(s.geom, hail_point(p_lat, p_lng));
$f$;

create or replace function public.hail_store_swaths(p_day date, p_bands jsonb, p_max numeric, p_source text, p_final boolean)
returns jsonb language plpgsql security definer set search_path = public, extensions as $f$
declare
  v_cov geometry;
  b jsonb;
begin
  -- A finished day is never overwritten by a live pass.
  if not p_final and exists (select 1 from hail_days where storm_day = p_day and final) then
    return jsonb_build_object('skipped', 'final');
  end if;
  select ST_Union(geom) into v_cov from hail_coverage;
  delete from hail_swaths where storm_day = p_day;
  for b in select * from jsonb_array_elements(coalesce(p_bands, '[]'::jsonb)) loop
    insert into hail_swaths (storm_day, band, geom, final, source)
    select p_day, (b->>'band')::numeric, g, p_final, p_source
      from (select ST_Multi(ST_CollectionExtract(ST_MakeValid(
                     ST_Intersection(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(b->>'geometry'), 4326)), v_cov)), 3)) as g) x
     where g is not null and not ST_IsEmpty(g);
  end loop;
  insert into hail_days (storm_day, final, max_mesh, source, processed_at)
  values (p_day, p_final, p_max, p_source, now())
  on conflict (storm_day) do update
    set final = excluded.final, max_mesh = excluded.max_mesh, source = excluded.source, processed_at = now();
  if p_final then
    delete from hail_live_grids where storm_day = p_day;
  end if;
  return storm_recompute_day(p_day);
end;
$f$;

-- ---------------------------------------------------------------------------
-- Storms + hits from the swaths (replaces the report / 3-mile version)
-- ---------------------------------------------------------------------------
create or replace function public.storm_refresh_last_hail(p_kind text, p_ids uuid[])
returns void language plpgsql security definer set search_path = public as $f$
begin
  -- A radar hit has a day, not a minute: noon Central that day.
  if p_kind = 'lead' then
    update leads l set last_hail_at = (h.storm_day::timestamp + interval '12 hours') at time zone 'America/Chicago',
                       last_hail_size = h.hail_size, last_hail_miles = null
      from (select distinct on (sh.record_id) sh.record_id, sh.storm_day, sh.hail_size
              from storm_hits sh
             where sh.kind = 'lead' and sh.record_id = any(p_ids)
             order by sh.record_id, sh.storm_day desc) h
     where l.id = h.record_id;
    update leads set last_hail_at = null, last_hail_size = null, last_hail_miles = null
     where id = any(p_ids) and not exists (select 1 from storm_hits where kind = 'lead' and record_id = leads.id);
  else
    update customers c set last_hail_at = (h.storm_day::timestamp + interval '12 hours') at time zone 'America/Chicago',
                           last_hail_size = h.hail_size, last_hail_miles = null
      from (select distinct on (sh.record_id) sh.record_id, sh.storm_day, sh.hail_size
              from storm_hits sh
             where sh.kind = 'customer' and sh.record_id = any(p_ids)
             order by sh.record_id, sh.storm_day desc) h
     where c.id = h.record_id;
    update customers set last_hail_at = null, last_hail_size = null, last_hail_miles = null
     where id = any(p_ids) and not exists (select 1 from storm_hits where kind = 'customer' and record_id = customers.id);
  end if;
end;
$f$;

create or replace function public.storm_recompute_day(p_day date)
returns jsonb language plpgsql security definer set search_path = public, extensions as $f$
declare
  v_ids_lead uuid[];
  v_ids_cust uuid[];
  v_old_lead uuid[];
  v_old_cust uuid[];
begin
  select coalesce(array_agg(record_id) filter (where kind = 'lead'), '{}'),
         coalesce(array_agg(record_id) filter (where kind = 'customer'), '{}')
    into v_old_lead, v_old_cust
    from storm_hits where storm_day = p_day;

  if not exists (select 1 from hail_swaths where storm_day = p_day and band >= storm_min_hail()) then
    delete from storms where storm_day = p_day;  -- hits cascade
    perform storm_refresh_last_hail('lead', v_old_lead);
    perform storm_refresh_last_hail('customer', v_old_cust);
    return jsonb_build_object('storm', false);
  end if;

  insert into storms (storm_day, max_hail, places, hail_reports)
  select p_day,
         (select max(band) from hail_swaths where storm_day = p_day),
         (select coalesce(array_agg(c.name || ', ' || c.state order by c.name), '{}')
            from hail_coverage c
           where exists (select 1 from hail_swaths s
                          where s.storm_day = p_day and s.band >= storm_min_hail() and ST_Intersects(s.geom, c.geom))),
         (select count(*) from storm_reports r
           where r.storm_day = p_day and r.kind = 'hail'
             and exists (select 1 from hail_coverage c where ST_Contains(c.geom, hail_point(r.lat, r.lng))))::int
  on conflict (storm_day) do update
    set max_hail = excluded.max_hail, places = excluded.places, hail_reports = excluded.hail_reports, updated_at = now();

  create temp table if not exists _storm_new (kind text, record_id uuid, miles numeric, hail_size numeric, report_id text) on commit drop;
  delete from _storm_new where true;  -- safeupdate refuses a bare DELETE

  insert into _storm_new
  select 'lead', l.id, 0, x.size, null
    from leads l
    cross join lateral (
      select max(s.band) as size from hail_swaths s
       where s.storm_day = p_day and ST_Contains(s.geom, hail_point(l.lat, l.lng))
    ) x
   where l.company = 'dc-solar' and l.removed_at is null and l.lat is not null and l.lng is not null
     and x.size >= storm_min_hail();

  insert into _storm_new
  select 'customer', c.id, 0, x.size, null
    from customers c
    cross join lateral (
      select max(s.band) as size from hail_swaths s
       where s.storm_day = p_day and ST_Contains(s.geom, hail_point(c.lat, c.lng))
    ) x
   where c.company = 'dc-solar' and c.lat is not null and c.lng is not null
     and x.size >= storm_min_hail();

  delete from storm_hits h
   where h.storm_day = p_day
     and not exists (select 1 from _storm_new n where n.kind = h.kind and n.record_id = h.record_id);
  insert into storm_hits (storm_day, kind, record_id, miles, hail_size, report_id)
  select p_day, kind, record_id, miles, hail_size, report_id from _storm_new
  on conflict (storm_day, kind, record_id) do update
    set miles = excluded.miles, hail_size = excluded.hail_size, report_id = excluded.report_id;

  perform storm_refresh_counts(p_day);

  select coalesce(array_agg(record_id) filter (where kind = 'lead'), '{}'),
         coalesce(array_agg(record_id) filter (where kind = 'customer'), '{}')
    into v_ids_lead, v_ids_cust
    from _storm_new;
  perform storm_refresh_last_hail('lead', array(select distinct unnest(v_ids_lead || v_old_lead)));
  perform storm_refresh_last_hail('customer', array(select distinct unnest(v_ids_cust || v_old_cust)));

  return jsonb_build_object('storm', true, 'leads', cardinality(v_ids_lead), 'customers', cardinality(v_ids_cust));
end;
$f$;

-- One record moved (or was placed): check it against every swath on file.
create or replace function public.storm_recheck_record(p_kind text, p_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $f$
declare
  v_lat double precision;
  v_lng double precision;
  v_days date[];
begin
  if p_kind = 'lead' then
    select lat, lng into v_lat, v_lng from leads where id = p_id and removed_at is null;
  else
    select lat, lng into v_lat, v_lng from customers where id = p_id;
  end if;
  select coalesce(array_agg(storm_day), '{}') into v_days from storm_hits where kind = p_kind and record_id = p_id;
  delete from storm_hits where kind = p_kind and record_id = p_id;
  if v_lat is not null and v_lng is not null then
    insert into storm_hits (storm_day, kind, record_id, miles, hail_size, report_id)
    select s.storm_day, p_kind, p_id, 0, max(s.band), null
      from hail_swaths s
      join storms st on st.storm_day = s.storm_day
     where ST_Contains(s.geom, hail_point(v_lat, v_lng))
     group by s.storm_day
    having max(s.band) >= storm_min_hail()
    on conflict do nothing;
  end if;
  perform storm_refresh_counts(d) from unnest(v_days || array(select storm_day from storm_hits where kind = p_kind and record_id = p_id)) d;
  perform storm_refresh_last_hail(p_kind, array[p_id]);
end;
$f$;

-- ---------------------------------------------------------------------------
-- The map's reads (staff)
-- ---------------------------------------------------------------------------
-- Swaths for one day (all bands) or a window (p_bands narrows it), simplified.
create or replace function public.hail_swaths_range(p_from date, p_to date, p_bands numeric[] default null)
returns table (storm_day date, band numeric, final boolean, geojson text)
language sql stable security definer set search_path = public, extensions as $f$
  select s.storm_day, s.band, s.final,
         ST_AsGeoJSON(ST_SimplifyPreserveTopology(s.geom, case when p_to - p_from > 1 then 0.003 else 0.0012 end), 4)
    from hail_swaths s
   where public.is_company_staff('dc-solar')
     and s.storm_day between p_from and p_to
     and (p_bands is null or s.band = any(p_bands))
   order by s.storm_day desc, s.band;
$f$;

-- The coverage outline (one shape) to draw on the map.
create or replace function public.hail_coverage_outline()
returns text language sql stable security definer set search_path = public, extensions as $f$
  select case when public.is_company_staff('dc-solar')
              then ST_AsGeoJSON(ST_SimplifyPreserveTopology(ST_Union(geom), 0.002), 4) end
    from hail_coverage;
$f$;

revoke all on function public.hail_store_swaths(date, jsonb, numeric, text, boolean) from public, anon, authenticated;
grant execute on function public.hail_store_swaths(date, jsonb, numeric, text, boolean) to service_role;
revoke all on function public.hail_swaths_range(date, date, numeric[]) from public, anon;
grant execute on function public.hail_swaths_range(date, date, numeric[]) to authenticated;
revoke all on function public.hail_coverage_outline() from public, anon;
grant execute on function public.hail_coverage_outline() to authenticated;
revoke all on function public.storm_refresh_last_hail(text, uuid[]) from public, anon, authenticated;
revoke all on function public.storm_recompute_day(date) from public, anon, authenticated;
revoke all on function public.storm_recheck_record(text, uuid) from public, anon, authenticated;
grant execute on function public.storm_recompute_day(date) to service_role;

commit;
