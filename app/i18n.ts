// The client's language: English by default, Simplified Chinese on request. Strings are written in place as
// L("English", "中文") so each text keeps both versions side by side; nothing is looked up by key.
import { signal } from "nsh";

export type Lang = "en" | "zh";
export const LANG_KEY = "hub.lang";
export const lang = signal<Lang>("en");
/** The text in the current language. Read inside a render or a function so a switch picks it up. */
export const L = (en: string, zh: string): string => (lang() === "zh" ? zh : en);

/** The language picker's rows, each named in its own language. */
export const LANGS: { id: Lang; label: string }[] = [
  { id: "en", label: "English" },
  { id: "zh", label: "简体中文" },
];
