package app.autosell.bridge;

import com.google.gson.*;
import java.util.*;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.client.multiplayer.chat.GuiMessage;
import net.minecraft.client.multiplayer.chat.GuiMessageSource;
import net.minecraft.network.chat.Component;
import net.minecraft.util.FormattedCharSequence;
import org.joml.Matrix3x2fc;
import org.joml.Vector2f;
import app.autosell.bridge.mixin.ChatLines;

/** Observes vanilla text submissions while the ordinary chat screen is open. Never draws or filters text. */
public final class ReceiptFrame {
  private static final IdentityHashMap<Component, String> messageIds = new IdentityHashMap<>();
  private static final ArrayDeque<Component> recent = new ArrayDeque<>();
  private static final List<Row> rows = new ArrayList<>();
  private static boolean armed, rendered, hovered;
  private static int frameWidth, frameHeight;

  private record Row(GuiMessage.Line line, String text, int left, int top, int right, int bottom) {}

  public static String identify(Component message) {
    // Keep distinct occurrences of identical text separate. Reused component instances are ambiguous.
    if (messageIds.containsKey(message)) {
      messageIds.put(message, "");
      return "";
    }
    String id = UUID.randomUUID().toString();
    recent.addLast(message);
    messageIds.put(message, id);
    if (recent.size() > 200) messageIds.remove(recent.removeFirst());
    return id;
  }

  static void arm(boolean value) {
    armed = value;
    rendered = false;
    rows.clear();
  }

  public static void beginFrame() {
    if (!armed) return;
    rendered = false;
    hovered = false;
    rows.clear();
  }

  public static void endFrame() {
    if (!armed) return;
    var mc = Minecraft.getInstance();
    var target = mc.gameRenderer.mainRenderTarget();
    rendered = !hovered && mc.gui.screen() instanceof ChatScreen && mc.gui.overlay() == null
        && target.width == mc.getWindow().getWidth() && target.height == mc.getWindow().getHeight();
    frameWidth = target.width;
    frameHeight = target.height;
  }

  public static void drawn(GuiGraphicsExtractor graphics, Font font, Matrix3x2fc pose,
      int y, float opacity, FormattedCharSequence content, boolean hasTooltip) {
    if (!armed) return;
    hovered |= hasTooltip;
    if (opacity < 0.65f) return;
    var mc = Minecraft.getInstance();
    // Vanilla's focused renderer supplies the exact sequence object, pose and baseline for each visible line.
    GuiMessage.Line line = ((ChatLines)mc.gui.hud.getChat()).autosell$trimmed().stream()
        .filter(item -> item.content() == content).findFirst().orElse(null);
    if (line == null || pose.m01() != 0 || pose.m10() != 0 || pose.m00() <= 0 || pose.m11() <= 0) return;
    int width = font.width(content);
    var a = pose.transformPosition(-1, y, new Vector2f());
    var b = pose.transformPosition(width + 2, y + font.lineHeight, new Vector2f());
    if (!graphics.containsPointInScissor((int)Math.floor(a.x), (int)Math.floor(a.y)) ||
        !graphics.containsPointInScissor((int)Math.ceil(b.x) - 1, (int)Math.ceil(b.y) - 1)) return;
    int scale = mc.getWindow().getGuiScale();
    var text = new StringBuilder();
    content.accept((index, style, codePoint) -> { text.appendCodePoint(codePoint); return true; });
    rows.add(new Row(line, text.toString(), (int)Math.floor(a.x * scale), (int)Math.floor(a.y * scale),
        (int)Math.ceil(b.x * scale), (int)Math.ceil(b.y * scale)));
  }

  static JsonObject manifest(JsonObject spec) {
    if (!rendered) throw new IllegalStateException("No completed focused-chat framebuffer");
    var expected = spec.getAsJsonArray("lines");
    if (expected == null || expected.isEmpty() || expected.size() > 100)
      throw new IllegalArgumentException("Unsupported payment evidence request");
    var output = new JsonArray();
    var chosen = Collections.newSetFromMap(new IdentityHashMap<GuiMessage.Line, Boolean>());
    int left = frameWidth, top = frameHeight, right = 0, bottom = 0;
    for (var element : expected) {
      var target = element.getAsJsonObject();
      String id = target.get("id").getAsString(), text = target.get("text").getAsString();
      var parts = rows.stream().filter(r -> r.line.parent().source() == GuiMessageSource.SYSTEM_SERVER
          && id.equals(messageIds.get(r.line.parent().content()))
          && text.equals(r.line.parent().content().getString())).sorted(Comparator.comparingInt(Row::top)).toList();
      // Require the entire message. A partially clipped or scrolled wrapped receipt cannot qualify.
      String joined = parts.stream().map(Row::text).reduce("", String::concat);
      if (parts.isEmpty() || !joined.replace(" ", "").equals(text.replace(" ", "")))
        throw new IllegalStateException("The complete verified payment line is not visible in chat");
      JsonArray boxes = new JsonArray();
      for (Row row : parts) {
        if (!chosen.add(row.line)) throw new IllegalStateException("Ambiguous duplicate receipt line");
        left = Math.min(left, row.left); top = Math.min(top, row.top);
        right = Math.max(right, row.right); bottom = Math.max(bottom, row.bottom);
        JsonArray box = new JsonArray();
        box.add(row.left); box.add(row.top); box.add(row.right); box.add(row.bottom);
        boxes.add(box);
      }
      JsonObject observed = target.deepCopy();
      observed.add("boxes", boxes);
      output.add(observed);
    }
    if (left < 0 || top < 0 || right > frameWidth || bottom > frameHeight)
      throw new IllegalStateException("Receipt is clipped by the game window");
    // Retain genuine balance replies between chunks. Other lines in the selected rectangle require review.
    for (Row row : rows) {
      if (chosen.contains(row.line) || row.bottom <= top || row.top >= bottom) continue;
      if (row.line.parent().source() != GuiMessageSource.SYSTEM_SERVER ||
          !row.line.parent().content().getString().matches("^You have \\$ [0-9.,]+[KkMmBbTt]?$"))
        throw new IllegalStateException("Unrelated chat overlaps verified payment lines");
    }
    JsonObject out = new JsonObject();
    out.addProperty("version", 1);
    out.addProperty("orderId", spec.get("orderId").getAsString());
    out.addProperty("frameWidth", frameWidth); out.addProperty("frameHeight", frameHeight);
    out.addProperty("x", left); out.addProperty("y", top);
    out.addProperty("width", right - left); out.addProperty("height", bottom - top);
    out.add("lines", output);
    return out;
  }
}
