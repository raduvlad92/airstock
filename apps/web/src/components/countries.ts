/**
 * Countries (ISO 3166-1 alpha-2) and the country each IANA time zone belongs to, so a form can
 * default a country from the shop time zone. Data from tzdb 2026e (iso3166.tab, zone.tab).
 */

const COUNTRY_CODES = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ ' +
  'BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM ' +
  'DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS ' +
  'GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN ' +
  'KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ ' +
  'MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM ' +
  'PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV ' +
  'SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI ' +
  'VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

/**
 * One country per zone, as in zone.tab, written as "CC zone zone …"; a country may take several
 * lines. Includes the older names that browsers still report, such as Asia/Calcutta.
 */
const ZONE_COUNTRIES = `
AD Europe/Andorra
AE Asia/Dubai
AF Asia/Kabul
AG America/Antigua
AI America/Anguilla
AL Europe/Tirane
AM Asia/Yerevan
AO Africa/Luanda
AQ Antarctica/Casey Antarctica/Davis Antarctica/DumontDUrville Antarctica/Mawson
AQ Antarctica/McMurdo Antarctica/Palmer Antarctica/Rothera Antarctica/Syowa Antarctica/Troll
AQ Antarctica/Vostok
AR America/Argentina/Buenos_Aires America/Argentina/Catamarca America/Argentina/Cordoba
AR America/Argentina/Jujuy America/Argentina/La_Rioja America/Argentina/Mendoza
AR America/Argentina/Rio_Gallegos America/Argentina/Salta America/Argentina/San_Juan
AR America/Argentina/San_Luis America/Argentina/Tucuman America/Argentina/Ushuaia
AR America/Buenos_Aires America/Catamarca America/Cordoba America/Jujuy America/Mendoza
AS Pacific/Pago_Pago
AT Europe/Vienna
AU Antarctica/Macquarie Australia/Adelaide Australia/Brisbane Australia/Broken_Hill
AU Australia/Darwin Australia/Eucla Australia/Hobart Australia/Lindeman Australia/Lord_Howe
AU Australia/Melbourne Australia/Perth Australia/Sydney
AW America/Aruba
AX Europe/Mariehamn
AZ Asia/Baku
BA Europe/Sarajevo
BB America/Barbados
BD Asia/Dhaka
BE Europe/Brussels
BF Africa/Ouagadougou
BG Europe/Sofia
BH Asia/Bahrain
BI Africa/Bujumbura
BJ Africa/Porto-Novo
BL America/St_Barthelemy
BM Atlantic/Bermuda
BN Asia/Brunei
BO America/La_Paz
BQ America/Kralendijk
BR America/Araguaina America/Bahia America/Belem America/Boa_Vista America/Campo_Grande
BR America/Cuiaba America/Eirunepe America/Fortaleza America/Maceio America/Manaus
BR America/Noronha America/Porto_Velho America/Recife America/Rio_Branco America/Santarem
BR America/Sao_Paulo
BS America/Nassau
BT Asia/Thimphu
BW Africa/Gaborone
BY Europe/Minsk
BZ America/Belize
CA America/Atikokan America/Blanc-Sablon America/Cambridge_Bay America/Coral_Harbour
CA America/Creston America/Dawson America/Dawson_Creek America/Edmonton America/Fort_Nelson
CA America/Glace_Bay America/Goose_Bay America/Halifax America/Inuvik America/Iqaluit
CA America/Moncton America/Rankin_Inlet America/Regina America/Resolute America/St_Johns
CA America/Swift_Current America/Toronto America/Vancouver America/Whitehorse
CA America/Winnipeg
CC Indian/Cocos
CD Africa/Kinshasa Africa/Lubumbashi
CF Africa/Bangui
CG Africa/Brazzaville
CH Europe/Zurich
CI Africa/Abidjan
CK Pacific/Rarotonga
CL America/Coyhaique America/Punta_Arenas America/Santiago Pacific/Easter
CM Africa/Douala
CN Asia/Shanghai Asia/Urumqi
CO America/Bogota
CR America/Costa_Rica
CU America/Havana
CV Atlantic/Cape_Verde
CW America/Curacao
CX Indian/Christmas
CY Asia/Famagusta Asia/Nicosia
CZ Europe/Prague
DE Europe/Berlin Europe/Busingen
DJ Africa/Djibouti
DK Europe/Copenhagen
DM America/Dominica
DO America/Santo_Domingo
DZ Africa/Algiers
EC America/Guayaquil Pacific/Galapagos
EE Europe/Tallinn
EG Africa/Cairo
EH Africa/El_Aaiun
ER Africa/Asmara Africa/Asmera
ES Africa/Ceuta Atlantic/Canary Europe/Madrid
ET Africa/Addis_Ababa
FI Europe/Helsinki
FJ Pacific/Fiji
FK Atlantic/Stanley
FM Pacific/Chuuk Pacific/Kosrae Pacific/Pohnpei Pacific/Ponape Pacific/Truk
FO Atlantic/Faeroe Atlantic/Faroe
FR Europe/Paris
GA Africa/Libreville
GB Europe/London
GD America/Grenada
GE Asia/Tbilisi
GF America/Cayenne
GG Europe/Guernsey
GH Africa/Accra
GI Europe/Gibraltar
GL America/Danmarkshavn America/Godthab America/Nuuk America/Scoresbysund America/Thule
GM Africa/Banjul
GN Africa/Conakry
GP America/Guadeloupe
GQ Africa/Malabo
GR Europe/Athens
GS Atlantic/South_Georgia
GT America/Guatemala
GU Pacific/Guam
GW Africa/Bissau
GY America/Guyana
HK Asia/Hong_Kong
HN America/Tegucigalpa
HR Europe/Zagreb
HT America/Port-au-Prince
HU Europe/Budapest
ID Asia/Jakarta Asia/Jayapura Asia/Makassar Asia/Pontianak
IE Europe/Dublin
IL Asia/Jerusalem
IM Europe/Isle_of_Man
IN Asia/Calcutta Asia/Kolkata
IO Indian/Chagos
IQ Asia/Baghdad
IR Asia/Tehran
IS Atlantic/Reykjavik
IT Europe/Rome
JE Europe/Jersey
JM America/Jamaica
JO Asia/Amman
JP Asia/Tokyo
KE Africa/Nairobi
KG Asia/Bishkek
KH Asia/Phnom_Penh
KI Pacific/Enderbury Pacific/Kanton Pacific/Kiritimati Pacific/Tarawa
KM Indian/Comoro
KN America/St_Kitts
KP Asia/Pyongyang
KR Asia/Seoul
KW Asia/Kuwait
KY America/Cayman
KZ Asia/Almaty Asia/Aqtau Asia/Aqtobe Asia/Atyrau Asia/Oral Asia/Qostanay Asia/Qyzylorda
LA Asia/Vientiane
LB Asia/Beirut
LC America/St_Lucia
LI Europe/Vaduz
LK Asia/Colombo
LR Africa/Monrovia
LS Africa/Maseru
LT Europe/Vilnius
LU Europe/Luxembourg
LV Europe/Riga
LY Africa/Tripoli
MA Africa/Casablanca
MC Europe/Monaco
MD Europe/Chisinau
ME Europe/Podgorica
MF America/Marigot
MG Indian/Antananarivo
MH Pacific/Kwajalein Pacific/Majuro
MK Europe/Skopje
ML Africa/Bamako
MM Asia/Rangoon Asia/Yangon
MN Asia/Hovd Asia/Ulaanbaatar
MO Asia/Macau
MP Pacific/Saipan
MQ America/Martinique
MR Africa/Nouakchott
MS America/Montserrat
MT Europe/Malta
MU Indian/Mauritius
MV Indian/Maldives
MW Africa/Blantyre
MX America/Bahia_Banderas America/Cancun America/Chihuahua America/Ciudad_Juarez
MX America/Hermosillo America/Matamoros America/Mazatlan America/Merida America/Mexico_City
MX America/Monterrey America/Ojinaga America/Tijuana
MY Asia/Kuala_Lumpur Asia/Kuching
MZ Africa/Maputo
NA Africa/Windhoek
NC Pacific/Noumea
NE Africa/Niamey
NF Pacific/Norfolk
NG Africa/Lagos
NI America/Managua
NL Europe/Amsterdam
NO Europe/Oslo
NP Asia/Kathmandu Asia/Katmandu
NR Pacific/Nauru
NU Pacific/Niue
NZ Pacific/Auckland Pacific/Chatham
OM Asia/Muscat
PA America/Panama
PE America/Lima
PF Pacific/Gambier Pacific/Marquesas Pacific/Tahiti
PG Pacific/Bougainville Pacific/Port_Moresby
PH Asia/Manila
PK Asia/Karachi
PL Europe/Warsaw
PM America/Miquelon
PN Pacific/Pitcairn
PR America/Puerto_Rico
PS Asia/Gaza Asia/Hebron
PT Atlantic/Azores Atlantic/Madeira Europe/Lisbon
PW Pacific/Palau
PY America/Asuncion
QA Asia/Qatar
RE Indian/Reunion
RO Europe/Bucharest
RS Europe/Belgrade
RU Asia/Anadyr Asia/Barnaul Asia/Chita Asia/Irkutsk Asia/Kamchatka Asia/Khandyga
RU Asia/Krasnoyarsk Asia/Magadan Asia/Novokuznetsk Asia/Novosibirsk Asia/Omsk Asia/Sakhalin
RU Asia/Srednekolymsk Asia/Tomsk Asia/Ust-Nera Asia/Vladivostok Asia/Yakutsk
RU Asia/Yekaterinburg Europe/Astrakhan Europe/Kaliningrad Europe/Kirov Europe/Moscow
RU Europe/Samara Europe/Saratov Europe/Ulyanovsk Europe/Volgograd
RW Africa/Kigali
SA Asia/Riyadh
SB Pacific/Guadalcanal
SC Indian/Mahe
SD Africa/Khartoum
SE Europe/Stockholm
SG Asia/Singapore
SH Atlantic/St_Helena
SI Europe/Ljubljana
SJ Arctic/Longyearbyen
SK Europe/Bratislava
SL Africa/Freetown
SM Europe/San_Marino
SN Africa/Dakar
SO Africa/Mogadishu
SR America/Paramaribo
SS Africa/Juba
ST Africa/Sao_Tome
SV America/El_Salvador
SX America/Lower_Princes
SY Asia/Damascus
SZ Africa/Mbabane
TC America/Grand_Turk
TD Africa/Ndjamena
TF Indian/Kerguelen
TG Africa/Lome
TH Asia/Bangkok
TJ Asia/Dushanbe
TK Pacific/Fakaofo
TL Asia/Dili
TM Asia/Ashgabat
TN Africa/Tunis
TO Pacific/Tongatapu
TR Europe/Istanbul
TT America/Port_of_Spain
TV Pacific/Funafuti
TW Asia/Taipei
TZ Africa/Dar_es_Salaam
UA Europe/Kiev Europe/Kyiv Europe/Simferopol
UG Africa/Kampala
UM Pacific/Midway Pacific/Wake
US America/Adak America/Anchorage America/Boise America/Chicago America/Denver
US America/Detroit America/Indiana/Indianapolis America/Indiana/Knox America/Indiana/Marengo
US America/Indiana/Petersburg America/Indiana/Tell_City America/Indiana/Vevay
US America/Indiana/Vincennes America/Indiana/Winamac America/Indianapolis America/Juneau
US America/Kentucky/Louisville America/Kentucky/Monticello America/Los_Angeles
US America/Louisville America/Menominee America/Metlakatla America/New_York America/Nome
US America/North_Dakota/Beulah America/North_Dakota/Center America/North_Dakota/New_Salem
US America/Phoenix America/Sitka America/Yakutat Pacific/Honolulu
UY America/Montevideo
UZ Asia/Samarkand Asia/Tashkent
VA Europe/Vatican
VC America/St_Vincent
VE America/Caracas
VG America/Tortola
VI America/St_Thomas
VN Asia/Ho_Chi_Minh Asia/Saigon
VU Pacific/Efate
WF Pacific/Wallis
WS Pacific/Apia
YE Asia/Aden
YT Indian/Mayotte
ZA Africa/Johannesburg
ZM Africa/Lusaka
ZW Africa/Harare
`;

let zoneCache: Map<string, string> | undefined;

function zoneCountries() {
  if (!zoneCache) {
    zoneCache = new Map();
    for (const line of ZONE_COUNTRIES.trim().split('\n')) {
      const [code, ...zones] = line.split(' ');
      for (const zone of zones) zoneCache.set(zone, code!);
    }
  }
  return zoneCache;
}

/** The country a time zone lies in, such as "DE" for Europe/Berlin; "" for UTC or an unknown zone. */
export function countryForTimeZone(timeZone: string): string {
  const map = zoneCountries();
  const direct = map.get(timeZone);
  if (direct) return direct;
  try {
    const canonical = new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone;
    return map.get(canonical) ?? '';
  } catch {
    return '';
  }
}

let nameCache: Intl.DisplayNames | undefined;

/** The English name of a country code, such as "Germany" for DE; the code itself if unknown. */
export function countryName(code: string): string {
  nameCache ??= new Intl.DisplayNames(['en'], { type: 'region' });
  try {
    return nameCache.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

let listCache: { code: string; name: string }[] | undefined;

/** Every country, sorted by its English name. */
export function countries() {
  listCache ??= COUNTRY_CODES.map((code) => ({ code, name: countryName(code) })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return listCache;
}
