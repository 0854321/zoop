import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { githubStarved } from "../src/github";

afterEach(() => mock.restore());

test("a machine without gh is not starved: the tick keeps picking up work", async () => {
  spyOn(Bun, "which").mockReturnValue(null);
  spyOn(Bun, "spawn").mockImplementation(() => { throw new Error('Executable not found in $PATH: "gh"'); });
  expect(await githubStarved({} as never)).toEqual({ starved: false, note: "" });
});
