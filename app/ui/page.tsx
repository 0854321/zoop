/**
 * The head of a page (a task, a memory file): its title block, set apart from the body by a hairline that runs the
 * page's full width, like the bar above it, even though the head itself sits in the reading column.
 */
import type { JSX, ViewStyle } from "nsh";
import { View } from "nsh";
import { colors } from "./theme";

export function PageHeader(props: { testID?: string; style?: ViewStyle; children?: JSX.Element }) {
  return (
    <View testID={props.testID} style={[{ position: "relative", gap: 8, paddingBottom: 20, marginBottom: 20 }, props.style ?? null]}>
      {props.children}
      {/* the page clips it at its edges */}
      <View style={{ position: "absolute", bottom: 0, left: -4000, right: -4000, height: 0.5, backgroundColor: colors.line }} />
    </View>
  );
}
