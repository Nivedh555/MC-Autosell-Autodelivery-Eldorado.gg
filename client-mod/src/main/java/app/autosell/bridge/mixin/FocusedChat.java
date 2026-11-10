package app.autosell.bridge.mixin;

import app.autosell.bridge.ReceiptFrame;
import net.minecraft.client.gui.ActiveTextCollector;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.util.FormattedCharSequence;
import net.minecraft.network.chat.Style;
import org.spongepowered.asm.mixin.*;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(targets = "net.minecraft.client.gui.components.ChatComponent$DrawingFocusedGraphicsAccess")
abstract class FocusedChat {
  @Shadow @Final private GuiGraphicsExtractor graphics;
  @Shadow @Final private Font font;
  @Shadow private ActiveTextCollector.Parameters parameters;
  @Shadow private Style hoveredStyle;

  @Inject(method = "handleMessage", at = @At("RETURN"))
  private void autosell$drawn(int y, float opacity, FormattedCharSequence line, CallbackInfoReturnable<Boolean> ci) {
    ReceiptFrame.drawn(graphics, font, parameters.pose(), y, opacity, line,
        hoveredStyle != null && hoveredStyle.getHoverEvent() != null);
  }
}
