package app.autosell.bridge;

import com.google.gson.*;
import java.net.URI;
import java.net.http.*;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.Pattern;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.SharedConstants;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.inventory.ChestMenu;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Local bridge to a real, logged-in client. Every request has a durable dispatch fence. */
public final class AutosellBridge implements ClientModInitializer {
  private static final Logger LOG = LoggerFactory.getLogger("autosell-bridge");
  private static final Gson JSON = new Gson();
  private static final Pattern COMMAND =
      Pattern.compile(
          "(?:/bal(?: \\.?[A-Za-z0-9_]{3,16})?|/pay \\.?[A-Za-z0-9_]{3,16} [1-9][0-9]{0,15}|/tpa"
              + " \\.?[A-Za-z0-9_]{3,16}|/home(?: [A-Za-z0-9_-]{1,32})?|/spawn|/ec)");
  private Minecraft mc;
  private final Path directory = FabricLoader.getInstance().getConfigDir().resolve("autosell");
  private final Set<String> dispatched = new HashSet<>();
  private volatile WebSocket socket;
  private volatile boolean connecting;
  private long nextConnect, sequence, ticks;
  private CompletableFuture<?> sends = CompletableFuture.completedFuture(null);
  private JsonObject config;
  private Job job;
  private String sessionHost;

  @Override
  public void onInitializeClient() {
    try {
      Path file = FabricLoader.getInstance().getConfigDir().resolve("autosell-bridge.json");
      if (!Files.exists(file)) {
        LOG.info(
            "Pair in Autosell V3 and save config/autosell-bridge.json, then restart Minecraft.");
        return;
      }
      config = JSON.fromJson(Files.readString(file), JsonObject.class);
      URI uri = URI.create(string(config, "url"));
      if (!"ws".equals(uri.getScheme())
          || !Set.of("127.0.0.1", "localhost").contains(uri.getHost())
          || uri.getUserInfo() != null)
        throw new IllegalArgumentException("Bridge URL must use loopback ws://127.0.0.1");
      if (!string(config, "accountId").matches("(buyer|seller)[1-9][0-9]?")
          || !string(config, "token").matches("[a-f0-9]{64}"))
        throw new IllegalArgumentException("Invalid pairing file");
      Files.createDirectories(directory);
      Path journal = directory.resolve("dispatch-journal.jsonl");
      // A corrupt/torn journal disables dispatch; never guess that a previous payment did not
      // execute.
      if (Files.exists(journal))
        for (String line : Files.readAllLines(journal))
          if (!line.isBlank()) dispatched.add(string(JSON.fromJson(line, JsonObject.class), "id"));
      ClientReceiveMessageEvents.GAME.register(
          (message, overlay) -> {
            if (!overlay) chat(message, "system");
          });
      ClientReceiveMessageEvents.CHAT.register(
          (message, signed, sender, type, time) -> chat(message, "chat"));
      ClientTickEvents.END_CLIENT_TICK.register(client -> {
        mc = client;
        tick();
      });
      LOG.info(
          "Autosell bridge loaded for {}. Join DonutSMP to connect.", string(config, "accountId"));
    } catch (Exception error) {
      config = null;
      LOG.error("Autosell bridge disabled: {}", error.getMessage());
    }
  }

  private boolean eligible() {
    return config != null
        && mc.player != null
        && mc.level != null
        && mc.getConnection() != null
        && mc.getCurrentServer() != null
        && mc.player.getGameProfile().name().equals(string(config, "ign"))
        && "26.3".equals(SharedConstants.getCurrentVersion().name())
        && matchesServer(mc.getCurrentServer().ip, string(config, "server"));
  }

  private static boolean matchesServer(String actual, String paired) {
    String host = actual.toLowerCase(Locale.ROOT).replaceFirst(":25565$", ""),
        target = paired.toLowerCase(Locale.ROOT).replaceFirst(":25565$", "");
    return host.equals(target)
        || (target.equals("donutsmp.net") && host.matches("([a-z0-9-]+\\.)+donutsmp\\.net"));
  }

  private void tick() {
    ticks++;
    if (!eligible()) {
      if (socket != null) {
        socket.abort();
        socket = null;
      }
      if (job != null) finish(job, false, null, "Client left paired account or server");
      return;
    }
    if (socket == null && !connecting && System.currentTimeMillis() > nextConnect) connect();
    if (socket != null && !mc.getCurrentServer().ip.equals(sessionHost)) {
      socket.abort();
      socket = null;
      return;
    }
    if (socket != null && ticks % 40 == 0) send(snapshot());
    Job current = job;
    if (current == null) return;
    try {
      if (System.currentTimeMillis() > current.expires)
        throw new IllegalStateException(
            "Operation timed out; inspect actual game state before retrying");
      current.tick.run();
    } catch (Exception error) {
      finish(current, false, null, error.getMessage());
    }
  }

  private void connect() {
    connecting = true;
    nextConnect = System.currentTimeMillis() + 10000;
    sessionHost = mc.getCurrentServer().ip;
    JsonObject hello = new JsonObject();
    hello.addProperty("type", "hello");
    for (String key : List.of("accountId", "ign", "token"))
      hello.addProperty(key, string(config, key));
    hello.addProperty("version", SharedConstants.getCurrentVersion().name());
    hello.addProperty("receiptGeometry", 1);
    hello.addProperty("host", sessionHost);
    HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build()
        .newWebSocketBuilder()
        .buildAsync(
            URI.create(string(config, "url")),
            new WebSocket.Listener() {
              final StringBuilder fragments = new StringBuilder();

              @Override
              public void onOpen(WebSocket ws) {
                synchronized (AutosellBridge.this) {
                  socket = ws;
                  sequence = 0;
                  sends = ws.sendText(JSON.toJson(hello), true);
                }
                connecting = false;
                ws.request(1);
              }

              @Override
              public CompletionStage<?> onText(WebSocket ws, CharSequence text, boolean last) {
                fragments.append(text);
                if (fragments.length() > 65536) {
                  ws.abort();
                  return null;
                }
                if (last) {
                  String body = fragments.toString();
                  fragments.setLength(0);
                  mc.execute(
                      () -> {
                        if (ws == socket) accept(body);
                      });
                }
                ws.request(1);
                return null;
              }

              @Override
              public CompletionStage<?> onClose(WebSocket ws, int code, String reason) {
                lost(ws);
                return null;
              }

              @Override
              public void onError(WebSocket ws, Throwable error) {
                lost(ws);
              }
            })
        .exceptionally(
            error -> {
              connecting = false;
              LOG.debug("Backend unavailable: {}", error.getMessage());
              return null;
            });
  }

  private void lost(WebSocket ws) {
    if (socket == ws) {
      socket = null;
      connecting = false;
      nextConnect = System.currentTimeMillis() + 10000;
      mc.execute(
          () -> {
            if (job != null) finish(job, false, null, "Bridge disconnected during operation");
          });
    }
  }

  private synchronized void send(JsonObject message) {
    WebSocket ws = socket;
    if (ws == null) return;
    message.addProperty("seq", ++sequence);
    String text = JSON.toJson(message);
    sends = sends.handle((v, e) -> null).thenCompose(v -> ws.sendText(text, true));
  }

  private void chat(Component component, String kind) {
    String text = component.getString();
    if (socket == null || !eligible() || text.length() > 4000) return;
    JsonObject msg = new JsonObject();
    msg.addProperty("type", "chat");
    msg.addProperty("text", text);
    msg.addProperty("kind", kind);
    if (kind.equals("system") && text.startsWith("You paid "))
      msg.addProperty("receiptId", ReceiptFrame.identify(component));
    if (kind.equals("system") && text.matches("^You have \\$ [0-9,.]+[KkMmBbTt]$")) {
      Set<String> balances = new HashSet<>();
      component.visit(
          (style, segment) -> {
            if (segment.matches(".*[0-9].*")
                && style.getHoverEvent() instanceof HoverEvent.ShowText hover) {
              String value =
                  hover
                      .value()
                      .getString()
                      .strip()
                      .replaceFirst("(?i)^(?:Exact balance|Balance):\\s*", "")
                      .replaceFirst("^\\$\\s*", "");
              if (value.matches("(?:[0-9]{1,18}|[0-9]{1,3}(?:,[0-9]{3}){1,5})"))
                balances.add(value.replace(",", ""));
            }
            return Optional.empty();
          },
          component.getStyle());
      if (balances.size() == 1) msg.addProperty("balanceHover", balances.iterator().next());
    }
    send(msg);
  }

  private void accept(String raw) {
    Job request = null;
    try {
      JsonObject message = JSON.fromJson(raw, JsonObject.class);
      String id = string(message, "id");
      UUID.fromString(id);
      request =
          new Job(
              id,
              string(message, "operation"),
              message.getAsJsonObject("args"),
              message.get("expiresAt").getAsLong());
      if (!eligible() || System.currentTimeMillis() > request.expires)
        throw new IllegalStateException("Expired request or unavailable game");
      if (dispatched.contains(id))
        throw new IllegalStateException(
            "Request already dispatched; inspect journal, never replay");
      if (job != null) throw new IllegalStateException("Another game operation is active");
      journal(request);
      switch (request.operation) {
        case "command" -> {
          String command = string(request.args, "command");
          if (!COMMAND.matcher(command).matches())
            throw new IllegalArgumentException("Unsupported command");
          mc.getConnection().sendCommand(command.substring(1));
          finish(request, true, object("sent", true), null);
        }
        case "snapshot" -> finish(request, true, snapshot(), null);
        case "screenshot" -> screenshot(request);
        case "home" -> home(request);
        case "collect" -> collect(request);
        case "store" -> store(request);
        default -> throw new IllegalArgumentException("Unsupported operation");
      }
    } catch (Exception error) {
      if (request != null) finish(request, false, null, error.getMessage());
      else LOG.warn("Rejected malformed bridge request");
    }
  }

  private void journal(Job request) throws Exception {
    JsonObject entry = new JsonObject();
    entry.addProperty("id", request.id);
    entry.addProperty("operation", request.operation);
    entry.add("args", request.args);
    entry.addProperty("at", System.currentTimeMillis());
    entry.addProperty("state", "DISPATCHED");
    byte[] bytes = (JSON.toJson(entry) + "\n").getBytes(StandardCharsets.UTF_8);
    try (FileChannel file =
        FileChannel.open(
            directory.resolve("dispatch-journal.jsonl"),
            StandardOpenOption.CREATE,
            StandardOpenOption.WRITE,
            StandardOpenOption.APPEND)) {
      ByteBuffer buffer = ByteBuffer.wrap(bytes);
      while (buffer.hasRemaining()) file.write(buffer);
      file.force(true);
    }
    dispatched.add(request.id);
  }

  private void finish(Job request, boolean ok, JsonObject result, String error) {
    if (!mc.isSameThread()) {
      mc.execute(() -> finish(request, ok, result, error));
      return;
    }
    if (request.done) return;
    request.done = true;
    request.cleanup.run();
    if (job == request) job = null;
    JsonObject message = new JsonObject();
    message.addProperty("type", "result");
    message.addProperty("id", request.id);
    message.addProperty("ok", ok);
    if (result != null) message.add("result", result);
    if (error != null) message.addProperty("error", error);
    send(message);
  }

  private void screenshot(Job request) {
    var previous = mc.gui.screen();
    if (previous != null && !(previous instanceof ChatScreen))
      throw new IllegalStateException("Close the current screen to capture payment chat");
    var chat = new ChatScreen("", false);
    boolean receipt = request.args.has("lines");
    job = request;
    mc.gui.setScreen(chat);
    ReceiptFrame.arm(receipt);
    request.cleanup =
        () -> {
          ReceiptFrame.arm(false);
          if (mc.gui.screen() == chat) mc.gui.setScreen(previous);
        };
    long after = ticks + 6;
    request.tick =
        () -> {
          if (ticks < after) return;
          if (mc.gui.screen() != chat || mc.gui.overlay() != null)
            throw new IllegalStateException("Payment chat was obscured before capture");
          JsonObject geometry = receipt ? ReceiptFrame.manifest(request.args) : null;
          request.tick = () -> {};
          Screenshot.takeScreenshot(
              mc.gameRenderer.mainRenderTarget(),
              nativeImage -> {
                try (nativeImage) {
                  Path file = directory.resolve("capture-" + request.id + ".png");
                  nativeImage.writeToFile(file);
                  byte[] bytes = Files.readAllBytes(file);
                  if (bytes.length > 5 * 1024 * 1024)
                    throw new IllegalStateException(
                        "Screenshot exceeds 5 MB; use a smaller game window");
                  JsonObject result = object("png", Base64.getEncoder().encodeToString(bytes));
                  if (geometry != null) {
                    if (nativeImage.getWidth() != geometry.get("frameWidth").getAsInt() ||
                        nativeImage.getHeight() != geometry.get("frameHeight").getAsInt())
                      throw new IllegalStateException("Framebuffer resolution changed during capture");
                    result.add("receipt", geometry);
                  }
                  finish(request, true, result, null);
                } catch (Exception error) {
                  finish(request, false, null, error.getMessage());
                }
              });
        };
  }

  private void home(Job request) {
    mc.getConnection().sendCommand("home");
    job = request;
    long after = ticks + 80;
    Vec3[] previous = {mc.player.position()};
    int[] stable = {0};
    request.tick =
        () -> {
          Vec3 pos = mc.player.position();
          stable[0] = pos.distanceTo(previous[0]) < 0.05 ? stable[0] + 1 : 0;
          previous[0] = pos;
          if (ticks > after && stable[0] > 40 && chestNearby() != null)
            finish(request, true, object("atStorage", true), null);
        };
  }

  private void collect(Job request) {
    String ign = string(request.args, "ign"), phase = string(request.args, "phase");
    int wanted = request.args.get("count").getAsInt();
    if (!ign.matches("\\.?[A-Za-z0-9_]{3,16}")
        || wanted < 1
        || wanted > 2304
        || !Set.of("prepare", "receive").contains(phase))
      throw new IllegalArgumentException("Invalid collection request");
    if (phase.equals("prepare") && nonEmptyInventory())
      throw new IllegalStateException("Intake inventory must be empty before collection");
    job = request;
    int[] stable = {0};
    boolean[] confirmed = {false};
    request.tick =
        () -> {
          if (phase.equals("prepare")
              && !confirmed[0]
              && mc.player.containerMenu instanceof ChestMenu menu) {
            String title =
                mc.gui.screen() == null
                    ? ""
                    : mc.gui.screen().getTitle().getString().toLowerCase(Locale.ROOT);
            if (!(title.contains("teleport") || title.contains("tpa")))
              throw new IllegalStateException("Unexpected confirmation menu during teleport");
            int selected = -1;
            for (int i = 0; i < menu.getContainer().getContainerSize(); i++) {
              String label =
                  menu.getContainer()
                      .getItem(i)
                      .getHoverName()
                      .getString()
                      .toLowerCase(Locale.ROOT);
              if (label.matches(".*\\b(confirm|accept|yes)\\b.*")) {
                if (selected >= 0)
                  throw new IllegalStateException("Ambiguous teleport confirmation");
                selected = i;
              }
            }
            if (selected < 0)
              throw new IllegalStateException("Teleport confirmation button unavailable");
            confirmed[0] = true;
            mc.gameMode.handleContainerInput(
                menu.containerId, selected, 0, ContainerInput.PICKUP, mc.player);
            return;
          }
          var seller =
              mc.level.players().stream()
                  .filter(p -> p.getGameProfile().name().equals(ign))
                  .findFirst()
                  .orElse(null);
          boolean nearby = seller != null && seller.distanceTo(mc.player) < 5;
          boolean crowd =
              mc.level.players().stream()
                  .anyMatch(
                      p ->
                          p != mc.player
                              && !p.getGameProfile().name().equals(ign)
                              && p.distanceTo(mc.player) < 8);
          if (crowd)
            throw new IllegalStateException(
                "Another player is near collection; operator review required");
          if (phase.equals("prepare")) {
            if (nonEmptyInventory())
              throw new IllegalStateException("Unexpected items arrived before seller was ready");
            if (nearby) finish(request, true, object("ready", true), null);
            return;
          }
          int count = strictInventoryCount();
          if (count > wanted)
            throw new IllegalStateException("Too many items received; operator review required");
          if (!nearby && count > 0)
            throw new IllegalStateException(
                "Seller left during collection; operator review required");
          stable[0] = nearby && count == wanted ? stable[0] + 1 : 0;
          if (stable[0] >= 40) {
            JsonObject result = object("verified", true);
            result.addProperty("count", count);
            finish(request, true, result, null);
          }
        };
  }

  private void store(Job request) {
    int expected = strictInventoryCount();
    if (expected == 0) throw new IllegalStateException("No verified skeleton spawners to store");
    BlockPos chest = chestNearby();
    if (chest == null)
      throw new IllegalStateException("Stand within reach of your ender chest at /home");
    if (mc.player.containerMenu != mc.player.inventoryMenu)
      throw new IllegalStateException("Close the current inventory before storing items");
    mc.gameMode.useItemOn(
        mc.player,
        InteractionHand.MAIN_HAND,
        new BlockHitResult(Vec3.atCenterOf(chest), Direction.UP, chest, false));
    job = request;
    int[] baseline = {-1}, menuId = {-1};
    long[] nextClick = {ticks + 15};
    int[] stable = {0};
    boolean[] moved = {false}, reopened = {false};
    request.tick =
        () -> {
          if (ticks < nextClick[0]) return;
          if (!(mc.player.containerMenu instanceof ChestMenu menu)
              || menu.getContainer().getContainerSize() != 27) {
            if (moved[0]) throw new IllegalStateException("Storage closed before verification");
            return;
          }
          if (menuId[0] == -1) {
            menuId[0] = menu.containerId;
            baseline[0] = chestCount(menu);
          }
          if (!reopened[0] && menuId[0] != menu.containerId)
            throw new IllegalStateException("Storage window changed");
          int remaining = strictInventoryCount(), stored = chestCount(menu);
          if (remaining == 0) {
            // Reopen the same physical ender chest. A fresh menu is populated by the server,
            // independent of local click prediction.
            if (!reopened[0]) {
              mc.player.closeContainer();
              mc.gameMode.useItemOn(
                  mc.player,
                  InteractionHand.MAIN_HAND,
                  new BlockHitResult(Vec3.atCenterOf(chest), Direction.UP, chest, false));
              reopened[0] = true;
              nextClick[0] = ticks + 20;
              return;
            }
            stable[0] =
                menu.containerId != menuId[0] && stored == baseline[0] + expected
                    ? stable[0] + 1
                    : 0;
            if (stable[0] >= 20) {
              mc.player.closeContainer();
              JsonObject result = object("success", true);
              result.addProperty("depositedCount", expected);
              finish(request, true, result, null);
            }
            return;
          }
          if (reopened[0])
            throw new IllegalStateException("Storage contents changed during verification");
          for (int i = 27; i < menu.slots.size(); i++)
            if (skeleton(menu.slots.get(i).getItem())) {
              mc.gameMode.handleContainerInput(
                  menu.containerId, i, 0, ContainerInput.QUICK_MOVE, mc.player);
              moved[0] = true;
              nextClick[0] = ticks + 15;
              return;
            }
        };
  }

  private int chestCount(ChestMenu menu) {
    int total = 0;
    for (int i = 0; i < 27; i++) {
      ItemStack item = menu.getContainer().getItem(i);
      if (skeleton(item)) total += item.getCount();
    }
    return total;
  }

  private BlockPos chestNearby() {
    if (mc.player == null || mc.level == null) return null;
    BlockPos base = mc.player.blockPosition();
    BlockPos found = null;
    double nearest = 20.25;
    for (BlockPos p : BlockPos.betweenClosed(base.offset(-4, -3, -4), base.offset(4, 3, 4))) {
      double distance = mc.player.getEyePosition().distanceToSqr(Vec3.atCenterOf(p));
      if (distance < nearest && mc.level.getBlockState(p).is(Blocks.ENDER_CHEST)) {
        nearest = distance;
        found = p.immutable();
      }
    }
    return found;
  }

  private boolean nonEmptyInventory() {
    for (int i = 0; i < mc.player.getInventory().getContainerSize(); i++)
      if (!mc.player.getInventory().getItem(i).isEmpty()) return true;
    return false;
  }

  private int strictInventoryCount() {
    int count = 0;
    for (int i = 0; i < mc.player.getInventory().getContainerSize(); i++) {
      ItemStack item = mc.player.getInventory().getItem(i);
      if (item.isEmpty()) continue;
      if (!skeleton(item))
        throw new IllegalStateException(
            "Unverified item type in inventory; names and lore are not accepted");
      count += item.getCount();
    }
    return count;
  }

  static boolean skeleton(ItemStack item) {
    if (!item.is(Items.SPAWNER)) return false;
    var data = item.get(DataComponents.BLOCK_ENTITY_DATA);
    if (data == null || !data.type().isValid(Blocks.SPAWNER.defaultBlockState())) return false;
    return "minecraft:skeleton"
        .equals(
            data.copyTagWithoutId()
                .getCompoundOrEmpty("SpawnData")
                .getCompoundOrEmpty("entity")
                .getStringOr("id", ""));
  }

  private JsonObject snapshot() {
    JsonObject out = new JsonObject();
    out.addProperty("type", "snapshot");
    out.addProperty("at", System.currentTimeMillis());
    out.addProperty("health", mc.player.getHealth());
    out.addProperty("food", mc.player.getFoodData().getFoodLevel());
    JsonObject position = new JsonObject();
    position.addProperty("x", mc.player.getX());
    position.addProperty("y", mc.player.getY());
    position.addProperty("z", mc.player.getZ());
    out.add("position", position);
    JsonArray inventory = new JsonArray();
    for (int i = 0; i < mc.player.getInventory().getContainerSize(); i++) {
      ItemStack item = mc.player.getInventory().getItem(i);
      if (item.isEmpty()) continue;
      JsonObject entry = new JsonObject();
      entry.addProperty("slot", i);
      entry.addProperty("name", BuiltInRegistries.ITEM.getKey(item.getItem()).getPath());
      entry.addProperty("count", item.getCount());
      entry.addProperty("displayName", item.getHoverName().getString());
      entry.addProperty("verifiedSkeleton", skeleton(item));
      inventory.add(entry);
    }
    out.add("inventory", inventory);
    return out;
  }

  private static String string(JsonObject object, String key) {
    return object.has(key) ? object.get(key).getAsString() : "";
  }

  private static JsonObject object(String key, Object value) {
    JsonObject object = new JsonObject();
    if (value instanceof Boolean b) object.addProperty(key, b);
    else object.addProperty(key, String.valueOf(value));
    return object;
  }

  private static final class Job {
    final String id, operation;
    final JsonObject args;
    final long expires;
    boolean done;
    Runnable tick = () -> {}, cleanup = () -> {};

    Job(String id, String operation, JsonObject args, long expires) {
      this.id = id;
      this.operation = operation;
      this.args = args;
      this.expires = expires;
    }
  }
}
