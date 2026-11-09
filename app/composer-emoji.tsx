import { keyboardFrame, safeArea, signal, Text, View, windowSize } from "nsh";
import { Button, Popover, Sheet } from "nsh/base";
import * as base from "nsh/base";
import { L } from "./i18n";
import { colors, hovered, Icon, Tip } from "./ui";
import { popupSurface } from "./ui/popup";

// Package updates can reach shells predating EmojiPicker. Keep those shells usable.
const EmojiPicker = base.EmojiPicker;
export const hasEmojiPicker = typeof EmojiPicker === "function";

export function ComposerEmoji(props: {
  touch: boolean;
  onOpen: () => void;
  onSelect: (emoji: string) => void;
  onInserted: () => void;
}) {
  if (!hasEmojiPicker) return null;
  const open = signal(false);
  const recent = signal<string[]>([]);
  let inserted = false;
  const change = (next: boolean) => {
    if (next) { inserted = false; props.onOpen(); }
    open.set(next);
  };
  const closed = () => {
    if (inserted) { inserted = false; props.onInserted(); }
  };
  const trigger = () => (
    <Button
      testID="emoji"
      accessibilityLabel={L("Choose emoji", "选择表情")}
      tooltip={props.touch ? undefined : <Tip label={L("Choose emoji", "选择表情")} />}
      onPress={props.touch ? () => change(true) : undefined}
      hoverStyle={hovered()}
      style={{ width: props.touch ? 44 : 36, height: props.touch ? 44 : 36, borderRadius: props.touch ? 22 : 18, alignItems: "center", justifyContent: "center" }}
    >
      <Icon name="smile" size={props.touch ? 22 : 19} tint={colors.text} />
    </Button>
  );
  const picker = () => (
    <EmojiPicker
      testID="emoji-picker"
      accessibilityLabel={L("Emoji", "表情")}
      searchAccessibilityLabel={L("Search emoji", "搜索表情")}
      placeholder={L("Search emoji", "搜索表情（英文名称）")}
      autoFocus={!props.touch}
      columns={props.touch ? Math.max(1, Math.min(7, Math.floor((windowSize().width - 16) / 44))) : 8}
      recent={recent()}
      groupLabels={{ recent: L("Recent", "最近使用"), smileysEmotion: L("Smileys & emotion", "笑脸与情感"), peopleBody: L("People & body", "人物与身体"), animalsNature: L("Animals & nature", "动物与自然"), foodDrink: L("Food & drink", "食物与饮料"), travelPlaces: L("Travel & places", "旅行与地点"), activities: L("Activities", "活动"), objects: L("Objects", "物品"), symbols: L("Symbols", "符号"), flags: L("Flags", "旗帜") }}
      onSelect={({ emoji, base }) => {
        recent.update((items) => [base, ...items.filter((item) => item !== base)].slice(0, 24));
        props.onSelect(emoji);
        inserted = true;
        change(false);
      }}
      onCancel={() => change(false)}
      style={{ width: props.touch ? "100%" : Math.min(336, windowSize().width - 32), height: Math.max(120, Math.min(380, windowSize().height - keyboardFrame().height - safeArea().top - safeArea().bottom - 96)) }}
      searchBarClass="mx-2 mt-2 h-11 flex-row items-center rounded-lg bg-muted px-3"
      searchClass="flex-1 text-base text-foreground placeholder:text-muted-foreground"
      rowClass="px-2"
      groupClass="px-3 pt-3 pb-1 text-xs font-semibold text-muted-foreground"
      itemClass="flex-1 h-11 items-center justify-center rounded-md text-2xl hover:bg-accent focus:bg-accent active:bg-accent"
      empty={<Text class="p-6 text-center text-sm text-muted-foreground">{L("No emoji found", "没有找到表情")}</Text>}
      loading={<Text class="p-6 text-center text-sm text-muted-foreground">{L("Loading emoji…", "正在加载表情…")}</Text>}
    />
  );
  return props.touch ? (
    <View>
      {trigger()}
      <Sheet open={open()} onOpenChange={({ open }) => change(open)} onClose={closed} closeOnSwipe
        popupClass="rounded-t-2xl bg-popover"
        popupStyle={{ paddingBottom: safeArea().bottom, marginBottom: keyboardFrame().height }}
        backdropClass="bg-foreground/20">
        <View class="flex-row items-center justify-between px-4 pt-2">
          <Text class="text-base font-semibold text-popover-foreground">{L("Emoji", "表情")}</Text>
          <Button testID="emoji-close" onPress={() => change(false)} accessibilityLabel={L("Close emoji", "关闭表情")} class="size-11 items-center justify-center rounded-full active:bg-accent">
            <Icon name="close" size={18} tint={colors.text} />
          </Button>
        </View>
        {picker()}
      </Sheet>
    </View>
  ) : (
    <Popover open={open()} onOpenChange={({ open }) => change(open)} onClose={closed}
      placement="top" align="start" offset={8} margin={12} popupStyle={popupSurface()} trigger={trigger()}>
      {picker()}
    </Popover>
  );
}
