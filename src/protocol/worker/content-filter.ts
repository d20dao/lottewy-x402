import { Profanity } from "@2toad/profanity";
import { type Draft } from "../shared/core";

export const LOCAL_CONTENT_POLICY = "lottewy-local-content-v2";
type Category = "profanity" | "hate" | "adult";
type PublicField = "title" | "description" | "rules";

const turkishTerms = [
  "siktir",
  "siktirin",
  "sikeyim",
  "sikerim",
  "sikik",
  "orospu",
  "orospucocugu",
  "amk",
  "aminakoyayim",
  "yarrak",
];
// Only English is enabled: the package has no Turkish dictionary. Explicit TR
// additions and our bounded evasion layer complement it without enabling
// unrelated language dictionaries. This remains lexical, not semantic review.
const profanity = new Profanity({
  languages: ["en"],
  wholeWord: true,
  unicodeWordBoundaries: true,
});
profanity.addWords(turkishTerms);
// A common personal name must not become an automatic moderation failure.
// This exact exception does not exempt profane compounds containing the name.
profanity.removeWords(["dick"]);

// Preserve common obfuscation coverage independently of upstream word-list
// changes. Explicit hate/adult categories provide more useful error messages.
const evasionTerms: Record<Category, readonly string[]> = {
  profanity: [
    "fuck",
    "fucks",
    "fucking",
    "fucker",
    "fuckers",
    "motherfucker",
    "shit",
    "bullshit",
    "asshole",
    "assholes",
    "bitch",
    "bitches",
    "cunt",
    ...turkishTerms,
  ],
  hate: ["nigger", "niggers", "nigga", "faggot", "faggots", "heil hitler"],
  adult: [
    "porn",
    "porno",
    "pornography",
    "pornographic",
    "pornografi",
    "pornografik",
    "hentai",
  ],
};
const letters: Record<string, string> = {
  a: "[a4@]",
  e: "[e3]",
  i: "[i1!|]",
  l: "[l1|]",
  o: "[o0]",
  s: "[s5$]",
  t: "[t7+]",
};
// Do not let separators consume leetspeak characters ($, !, @, |, +). Keeping
// those character sets disjoint prevents combinatorial backtracking on spam.
const separator = "[\\s._*#%/:,;?—–-]*";
const patterns = Object.entries(evasionTerms).map(([category, words]) => ({
  category: category as Category,
  expression: new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${words
      .map((word) =>
        Array.from(word.replaceAll(" ", ""))
          .map((letter) => letters[letter] || letter)
          .join(separator),
      )
      .join("|")})(?![\\p{L}\\p{N}])`,
    "u",
  ),
}));
// Keep this Turkish spelling distinct: stripping its cedilla would also block
// the ordinary English abbreviation "pic".
const nativeProfanity = new RegExp(
  `(?<![\\p{L}\\p{N}])p${separator}[iı1!|]${separator}ç(?![\\p{L}\\p{N}])`,
  "u",
);
const homoglyphs: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
  у: "y",
  і: "i",
  ѕ: "s",
};
function comparable(text: string) {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}/gu, "")
    .replace(/\p{Cf}/gu, "")
    .replaceAll("ı", "i")
    .replace(/[аеорсхуіѕ]/gu, (letter) => homoglyphs[letter]);
}

export function publicContentViolations(draft: Pick<Draft, PublicField>) {
  const violations: { field: PublicField; category: Category }[] = [];
  for (const field of ["title", "description", "rules"] as const) {
    const text = comparable(draft[field]);
    const hasProfanity = profanity.exists(text);
    const categories = new Set<Category>();
    for (const pattern of patterns) {
      // The package handles plain word matching; custom profanity patterns are
      // a fallback for disguised spellings it does not recognize.
      if (pattern.category === "profanity" && hasProfanity) continue;
      if (
        pattern.expression.test(text) ||
        (pattern.category === "profanity" &&
          nativeProfanity.test(
            draft[field]
              .normalize("NFKC")
              .toLowerCase()
              .replace(/\p{Cf}|\u0307/gu, ""),
          ))
      )
        categories.add(pattern.category);
    }
    // Prefer specific adult/hate guidance over the package's generic profanity
    // label when its dictionary overlaps our explicit categories.
    if (categories.size === 0 && hasProfanity) categories.add("profanity");
    for (const category of categories) violations.push({ field, category });
  }
  return violations;
}

export function assertPublicContent(draft: Pick<Draft, PublicField>) {
  const violations = publicContentViolations(draft);
  const labels: Record<PublicField, string> = {
    title: "Title",
    description: "Description",
    rules: "Rules",
  };
  const hints: Record<Category, string> = {
    profanity: "profanity or vulgar language",
    hate: "a hateful slur or phrase",
    adult: "an adult-content term",
  };
  if (violations.length)
    throw Object.assign(
      new Error(
        `${violations.map(({ field, category }) => `${labels[field]} contains ${hints[category]}.`).join(" ")} Remove the blocked wording and try again. Your draft is preserved; nothing was saved.`,
      ),
      { code: "CONTENT_REVIEW_REJECTED" },
    );
}
