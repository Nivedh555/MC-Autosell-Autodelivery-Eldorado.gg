package app.autosell.bridge.mixin;

import app.autosell.bridge.ReceiptFrame;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.renderer.GameRenderer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(GameRenderer.class)
abstract class RenderedFrame {
  @Inject(method = "extract", at = @At("HEAD"))
  private void autosell$begin(DeltaTracker tracker, boolean tick, CallbackInfo ci) { ReceiptFrame.beginFrame(); }

  @Inject(method = "render", at = @At("RETURN"))
  private void autosell$rendered(CallbackInfo ci) { ReceiptFrame.endFrame(); }
}
