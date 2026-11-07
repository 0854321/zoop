import { cleanup, Overlay, platform, reduceMotion, safeArea, signal, Text } from "nsh";
import { Toast, ToastManager, ToastStack, type ToastEntry } from "nsh/base";
import { colors, Icon, radius } from "./ui";

/** One retained save confirmation, shared by all settings pages. */
export function createSettingsToast() {
  const manager = new ToastManager();
  const entries = signal<ToastEntry[]>([]);
  const expanded = signal(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  const sync = () => entries.set(manager.visible(1));
  function run() {
    sync();
    timer ??= setInterval(() => {
      const result = manager.advance(expanded());
      if (result.changed) sync();
      if (manager.isEmpty()) { clearInterval(timer); timer = undefined; }
    }, 50);
  }
  function dismiss() {
    if (disposed || manager.isEmpty()) return;
    manager.dismissAll();
    run();
  }
  cleanup(() => { disposed = true; clearInterval(timer); manager.dispose(); });
  return {
    entries, expanded, dismiss,
    show(message: string) {
      if (disposed) return;
      manager.push("settings-saved", message, { timeout: 2000 });
      run();
    },
  };
}

export function SettingsToast(props: { state: ReturnType<typeof createSettingsToast> }) {
  return (
    <Overlay style={{ pointerEvents: "box-none", left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingBottom: safeArea().bottom + 16, alignItems: "center" }}>
      <ToastStack closeOnEscape={platform.os !== "ios" && platform.os !== "android"} placement="bottomCenter" style={{ width: 280, maxWidth: "100%" }}
        motion={reduceMotion() ? { duration: 0 } : undefined}
        onExpandedChange={({ expanded }) => props.state.expanded.set(expanded)}
        onCancel={props.state.dismiss}>
        <Each of={props.state.entries()} key={(entry) => entry.id}>
          {(entry) => (
            <Toast testID="settings-toast" transitionStatus={entry().status}
              accessibilityLabel={String(entry().value)} onDismissRequest={props.state.dismiss}
              class="transition-all duration-200 motion-reduce:transition-none"
              startingClass={reduceMotion() ? "" : "opacity-0 translate-y-2"}
              endingClass="opacity-0" swipingClass="transition-none"
              style={{ flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderRadius: radius.inset, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised }}>
              <Icon name="check" size={18} tint={colors.up} />
              <Text style={{ fontSize: 14, color: colors.text }}>{String(entry().value)}</Text>
            </Toast>
          )}
        </Each>
      </ToastStack>
    </Overlay>
  );
}
