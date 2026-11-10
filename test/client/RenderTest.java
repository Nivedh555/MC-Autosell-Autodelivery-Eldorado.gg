package app.autosell.bridge;
import com.google.gson.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import net.fabricmc.fabric.api.client.gametest.v1.*;
import net.fabricmc.fabric.api.client.gametest.v1.context.*;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.network.chat.Component;
import net.minecraft.client.Screenshot;

public final class RenderTest implements FabricClientGameTest {
 public void runTest(ClientGameTestContext test) {
  var ids=new LinkedHashMap<String,String>();
  ClientReceiveMessageEvents.GAME.register((body,overlay)->{
   if (!overlay && body.getString().startsWith("You paid ")) ids.put(body.getString(),ReceiptFrame.identify(body));
  });
  try(var world=test.worldBuilder().create()) {
   world.getConnection().waitForChunksRender();
   for (String msg:List.of("Synthetic local test","You paid FixturePlayer $ 100M","You have $ 24,000,000","You paid FixturePlayer $ 12M"))
     world.getServer().runOnServer(server->server.getPlayerList().getPlayers().forEach(p->p.sendSystemMessage(Component.literal(msg))));
   test.waitFor(mc->ids.size()==2,200);
   var spec=new JsonObject();spec.addProperty("orderId","local-render-regression");
   var lines=new JsonArray();
   for(var entry:ids.entrySet()){var x=new JsonObject();x.addProperty("text",entry.getKey());x.addProperty("id",entry.getValue());lines.add(x);}
   spec.add("lines",lines);
   for(int[] settings:new int[][]{{854,480,1},{1280,720,2},{1280,720,3}}){
    String name="fixture-"+settings[0]+"-"+settings[1]+"-"+settings[2];
    test.runOnClient(mc->{
      mc.getWindow().setWindowed(settings[0],settings[1]);
      mc.options.guiScale().set(settings[2]);
      mc.options.chatScale().set(settings[2]==3?0.75:1.0);
      mc.options.chatLineSpacing().set(settings[2]==2?0.5:0.0);
      mc.resizeGui();
      mc.gui.setScreen(new ChatScreen("",false));
      ReceiptFrame.arm(true);
    });
    test.waitTicks(10);
    var done=new CompletableFuture<Boolean>();
    test.runOnClient(mc->{
      var geometry=ReceiptFrame.manifest(spec);
      try {Files.writeString(Path.of(name+".json"),geometry.toString());} catch(Exception e){throw new RuntimeException(e);}
      Screenshot.takeScreenshot(mc.gameRenderer.mainRenderTarget(),image->{
       try(image){image.writeToFile(Path.of(name+".png"));done.complete(true);}catch(Throwable e){done.completeExceptionally(e);}
      });
    });
    test.waitFor(mc->done.isDone(),100);done.join();
    test.runOnClient(mc->{ReceiptFrame.arm(false);mc.gui.setScreen(null);});
   }
   test.restoreDefaultGameOptions();
  }
 }
}
