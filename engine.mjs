import { createHmac, randomInt, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const words = JSON.parse(readFileSync(join(process.cwd(), "data/words.json")));
const buf = readFileSync(join(process.cwd(), "data/vectors.bin"));
const vectors = new Float32Array(
  buf.buffer,
  buf.byteOffset,
  buf.byteLength / 4,
);
const manifest = JSON.parse(
  readFileSync(join(process.cwd(), "data/manifest.json")),
);
for (const name of ["words.json", "vectors.bin"]) {
  const contents = readFileSync(join(process.cwd(), "data", name));
  if (
    createHash("sha256").update(contents).digest("hex") !== manifest.files[name]
  )
    throw Error(`Word artifact checksum failed: ${name}`);
}
if (
  manifest.dimensions !== 50 ||
  words.length !== manifest.vocabulary ||
  vectors.length !== words.length * 50
)
  throw Error("Word artifacts have incompatible dimensions.");
const indexes = new Map(words.map((w, i) => [w, i]));
export const targets =
  "ocean garden mountain coffee music river forest window paper school kitchen flower island candle bottle camera silver summer winter animal planet castle bridge dream apple bread thunder village library feather desert mirror blanket barrel cat dog horse rabbit tiger lion elephant monkey bear wolf fox deer sheep cow pig goat chicken duck goose eagle owl parrot fish shark whale dolphin turtle snake frog butterfly spider bee ant beetle dragonfly bird nest wing tail claw paw fur grass tree leaf branch root seed fruit orange lemon peach pear grape banana cherry strawberry melon pineapple coconut mango tomato potato carrot onion garlic pepper corn rice wheat flour sugar salt honey butter cheese milk cream yogurt egg cake cookie biscuit chocolate candy soup salad sandwich pizza pasta burger sausage steak meat beef pork mushroom bean pea nut almond walnut olive avocado cucumber pumpkin cabbage lettuce spinach celery broccoli watermelon apricot plum raspberry blueberry blackberry lime fig date raisin squirrel zebra giraffe camel donkey mouse rat bat otter seal walrus penguin flamingo swan crow raven sparrow robin woodpecker shell crab lobster shrimp octopus jellyfish coral reef beach coast shore sand stone rock pebble cliff cave valley hill field meadow farm pond lake stream waterfall spring rain snow ice frost cloud sky wind storm lightning rainbow sunrise sunset moon sun star galaxy universe space rocket astronaut satellite comet meteor earth world country city town street road highway lane path trail track railway train bus car truck bicycle motorcycle boat ship airplane helicopter balloon wheel engine motor fuel petrol gasoline brake tire seat door roof wall ceiling floor stair ladder room bedroom bathroom hallway attic basement porch balcony terrace chimney fireplace gate fence yard lawn hedge bush bark vine rose tulip daisy lily orchid violet sunflower blossom petal thorn palm pine oak maple willow birch cedar bamboo fern moss jungle rainforest wood timber plank log board nail screw hammer saw drill knife fork spoon plate bowl cup mug glass jar can box basket bag suitcase pocket wallet purse envelope letter stamp book novel story poem newspaper magazine diary notebook pencil pen marker chalk crayon paint brush canvas drawing picture photo portrait sculpture statue art museum gallery theater cinema stage actor actress singer dancer song melody rhythm guitar piano violin drum trumpet flute horn bell sound voice whisper silence echo noise radio speaker microphone headphone television screen computer laptop tablet phone keyboard printer scanner cable wire battery charger switch socket bulb lamp lantern torch light shadow color red blue green yellow black white gray purple pink brown gold metal steel iron copper bronze aluminum plastic rubber leather cotton wool silk fabric cloth shirt dress skirt coat jacket sweater scarf glove hat cap boot shoe sock belt button zipper needle thread rope string chain ring necklace bracelet watch clock calendar hour minute second day week month year morning evening night today tomorrow yesterday time history future memory thought idea question answer word language speech conversation meeting party wedding birthday festival holiday vacation travel journey trip ticket passport map compass station airport harbor hotel restaurant cafe bakery market shop store mall office factory hospital clinic pharmacy bank college university classroom desk chair bench table shelf cupboard cabinet drawer bed pillow mattress quilt towel soap shampoo perfume toothpaste comb toothbrush razor laundry washing cleaner broom bucket mop sponge dish oven stove refrigerator freezer kettle toaster microwave pan pot lid handle teapot recipe meal breakfast lunch dinner feast drink tea juice wine beer soda water fountain well pipe tap sink drain sewer canal dam reservoir tunnel tower building house home apartment cottage cabin palace temple church mosque cathedral monument stadium park playground zoo aquarium circus carnival fair game toy doll puzzle ball football basketball tennis golf baseball soccer cricket hockey volleyball racket goal net team player coach captain champion medal trophy prize award race match competition sport exercise fitness yoga dance swim running walking hiking climbing skiing skating surfing fishing hunting camping tent camp fire flame smoke ash coal gas energy power electricity heat temperature weather climate season nature environment ecology science biology chemistry physics medicine doctor nurse surgeon dentist patient treatment cure health heart brain blood bone muscle skin hair eye ear nose mouth tooth tongue lip cheek chin neck shoulder arm hand finger thumb wrist elbow leg knee foot toe ankle chest stomach belly back face head body mind soul spirit love hope joy peace trust truth beauty courage wisdom knowledge education learning lesson teacher student friend family mother father parent child baby son daughter sister brother cousin uncle aunt grandmother grandfather husband wife partner neighbor stranger person people crowd group club society community culture tradition custom habit work job career business company manager worker farmer baker cook chef writer author poet artist architect engineer scientist lawyer judge police soldier sailor pilot driver carpenter plumber electrician mechanic tailor barber waiter fisherman hunter explorer traveler tourist guide leader president king queen prince princess crown throne law rule court justice freedom nation flag border battle war army navy victory defeat danger safety risk chance luck fortune treasure wealth money coin cash bill cost price value poverty gift present surprise secret mystery magic fairy wizard witch ghost monster giant dragon angel devil hero villain knight sword shield spear bow arrow gun rifle bullet weapon armor helmet uniform suit costume mask robot machine tool instrument device equipment furniture vehicle transport traffic speed distance direction north south east west left right center middle top bottom edge corner side front inside outside surface depth height width length weight size shape circle square triangle rectangle diamond cube sphere pyramid spiral pattern texture design style fashion model material object thing product package parcel delivery service support help care comfort pleasure fun adventure experience event moment opportunity problem solution reason cause effect result success failure effort practice skill talent ability strength weakness patience kindness respect friendship happiness sadness anger fear worry wonder curiosity interest focus attention balance motion movement force gravity pressure volume measure number amount quantity quality level degree rank order list array series set collection variety choice option decision plan purpose task project process method system network internet website software program application code data information message mail chat email account password username profile identity name title label address location position place region area zone district capital continent Africa Europe Asia America Australia Pacific Atlantic Arctic Indian Mediterranean"
    .split(" ")
    .filter((w) => indexes.has(w));
const cache = new Map();
export function ranking(target) {
  if (cache.has(target)) return cache.get(target);
  const t = indexes.get(target);
  if (t === undefined) throw Error("Unknown secret word");
  const scores = words.map((word, i) => {
    let score = 0;
    for (let k = 0; k < 50; k++)
      score += vectors[i * 50 + k] * vectors[t * 50 + k];
    return { word, score };
  });
  scores.sort((a, b) => b.score - a.score);
  const ranks = new Map(scores.map((s, i) => [s.word, i + 1]));
  const result = { ranks, ordered: scores.map((s) => s.word) };
  cache.set(target, result);
  if (cache.size > 8) cache.delete(cache.keys().next().value);
  return result;
}
export function rankWord(target, word) {
  if (!indexes.has(word))
    throw Error("Word not found. Try another English word.");
  const r = ranking(target).ranks.get(word);
  if (!r) throw Error("Word not found. Try another English word.");
  return r;
}
export function daily(secret) {
  const day = Math.floor(Date.now() / 86400000);
  const index = secret
    ? createHmac("sha256", secret)
        .update(String(day))
        .digest()
        .readUInt32BE(0) % targets.length
    : day % targets.length;
  return {
    id: day,
    target: targets[index],
    number: Math.floor((Date.now() - Date.UTC(2025, 0, 1)) / 86400000) + 1,
  };
}
export function randomTarget() {
  return targets[randomInt(targets.length)];
}
export function hintWord(target, guesses, difficulty = "easy") {
  const { ordered } = ranking(target);
  const best = Math.min(1000, ...guesses.map((g) => g.rank));
  let pos =
    difficulty === "medium"
      ? best - 1
      : difficulty === "hard"
        ? 2 + randomInt(Math.max(2, best - 2))
        : Math.max(2, Math.floor(best / 2));
  pos = Math.max(2, pos);
  while (pos > 1 && guesses.some((g) => g.word === ordered[pos - 1])) pos--;
  return ordered[pos - 1];
}
