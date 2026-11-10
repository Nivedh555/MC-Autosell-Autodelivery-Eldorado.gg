# Start Eldorado delivery

Run Autosell, the seller browser, and Minecraft on the same computer. Use your own Eldorado seller account and the Minecraft account that holds the coins. Eldorado delivery works independently of Discord and Litecoin.

## First setup on Windows

1. Run the Windows installer and open **Autosell V3** from Start. The desktop build includes Node and Chromium. For a fresh installation, choose a vault passphrase of at least 12 characters and set up the dashboard owner password. To move your existing installation, close its backend and seller browser, use the desktop import option before creating a new workspace, select the old application folder and unlock it with your existing passphrase. If you are running from source, install Node.js 24, run **Install-Windows.cmd**, then **Start-Windows.cmd** and open the dashboard address printed in the console.
2. In **Eldorado Setup**, use **Browser + API**. Under **Seller API credentials**, enter your Client ID and full Client secret from the same Eldorado seller account. Click **Save API credentials**. If a restart is required in the desktop app, choose **Exit safely** in **Updates & settings** or the system tray, wait for it to close, then reopen **Autosell V3**. For a source installation, stop the backend with Ctrl+C and launch **Start-Windows.cmd** again with the same passphrase.
3. Under **Open your seller browser**, choose **Bundled Chromium (dedicated profile)** and save the choice if it changed. Click **Open seller browser**. Autosell opens the saved profile and checks it once. If it asks for login, sign in to Eldorado in that window, then click **Check startup** in Autosell. This profile remembers your login. Choosing **Existing Google Chrome profile** instead uses Chrome’s remote-debugging permission and connection prompt.
4. Install Prism Launcher and sign into your Microsoft Minecraft account in Prism. Open **AutoSell Pairs → Minecraft delivery clients → Set up Minecraft in Prism**. Choose a compatible instance or create one, select **seller1**, enter your exact in-game name, close the instance, and click **Install mods and pair**. Launch the named instance in Prism, join the configured server, and check that the account shows **Online**. [Minecraft setup and troubleshooting](MINECRAFT-SETUP.md)
5. While global trading is off, go to **Eldorado Setup → Existing currency offer → Find existing offers**. Select your own DonutSMP Money offer and **seller1**, then click **Link offer**. If you do not yet have an offer, create one under **Eldorado → My Offers → New Offer** first. Set its quantity to coins you can deliver after reserves and outstanding orders. Set the delivery pair’s minimum-stock threshold to a balance you can actually maintain.
6. In **Eldorado Setup → Delivery readiness**, click **Check startup** and follow the displayed next action. Turn on **Global Autosell** when ready to fulfill real purchases. The periodic stock worker reads the in-game balance and manages the availability of the linked offer. Allow one stock-check cycle, normally about 30 seconds. The panel checks four things: seller browser, Minecraft and stock, Eldorado offer, and automation. **Ready for incoming orders** means all four currently pass. Keep Minecraft, the seller browser and Autosell running.

## Choose what customers receive

Open **Customer Messages**, choose an order stage, edit the wording, check its preview and save. Enable **Order marked delivered** to send your completion text. Include `{order_url}` for that buyer’s order link. The required recipient confirmation shows the exact IGN and amount. The genuine cropped receipt is sent after verification. The two instructional pictures are optional. A message already scheduled keeps its original text when you edit its template.

## Starting again tomorrow

1. Open **Autosell V3** from Start (or **Start-Windows.cmd** when running from source) and unlock your vault. Open Prism → **Autosell Delivery** and join **donutsmp.net**.
2. Open the dashboard → **Eldorado Setup**. Click **Open seller browser**. It checks the saved session once. If login is required, sign in and click **Check startup**. Follow **Delivery readiness**. Enable **Global Autosell** if you previously paused it.
3. Check the offer in **My Offers**. **Active** means it can receive orders. A connected browser means Autosell can operate the seller session. Global automation being on means the worker may process eligible orders. Those two indicators alone do not establish that the offer is active. If the offer says **Closed**, inspect that exact offer on Eldorado and follow the dashboard’s next action. If stock is short, fund the delivery account or reduce the advertised quantity.

Keep the same pairing file on later starts. Downloading a new one replaces the token for that slot. **Eldorado Orders → Order proof and review** shows payment or message cases that need attention.

## Understanding the indicators

- **Browser connected** means Autosell has a browser connection. **Seller login verified** confirms the signed-in seller. The old internal label **ATTACHED_PAUSED** did not mean the Eldorado offer was paused, and did not need its own resume switch.
- **AUTOMATION ON** means Global Autosell allows processing. It does not prove your offer is live. Read the four checks under Delivery readiness.
- **Active** is Eldorado’s confirmed offer status. **Paused**, **Closed**, and **Offline** are different states. Autosell can resume the linked Paused offer after stock checks. It may attempt one guarded reopen for a Closed offer. If Eldorado rejects that action or the result is uncertain, the panel shows the problem instead of repeatedly submitting it. For **Offline**, turn off Offline mode in Eldorado Account settings yourself.
- **Check startup** reads the connection and offer. It does not turn automation on, change price or quantity, or send coins. The regular worker handles the offer after Global Autosell is enabled. If an older dashboard reports **Restart Start-Windows.cmd**, restart the application using the desktop or source steps above.

Existing manual offers keep their chosen price and advertised quantity. Ensure the in-game balance covers that quantity, configured reserves and unpaid orders, and reaches the delivery pair’s stock threshold. For example, a 200M offer cannot stay available with only 150M unreserved stock. Fund the account or edit the quantity of the same offer on Eldorado.

If the desktop dashboard cannot open, check the startup status in the app. A source installation requires its Autosell console to remain open; use the address printed there. If Minecraft is online in the game but offline in the dashboard, check that you launched the paired Fabric instance with both release JARs and its own pairing file. The exact account name, server and mod version must match.

## Uninstall on Windows

Choose **Exit safely** in Autosell, then open Start → **Uninstall Autosell V3**. To erase this Windows user's saved desktop workspace too, select **Remove all Autosell data** and confirm. This permanently deletes the wallet vault, payment history, screenshots, saved browser sessions and desktop migration backups. Export any wallet recovery information you intend to keep before choosing this option. Prism instances and the original folder you imported are stored separately.

## Running on a Linux VPS

Use a graphical Linux desktop with Node.js 24, npm, Java 25 and a working Minecraft graphics driver. Extract the ZIP, open a terminal in the app folder and run:

```sh
bash linux/install.sh
bash linux/start.sh
```

Open **http://127.0.0.1:4203** in the VPS desktop, then follow steps 2–6 above. To install the mod and pairing file after downloading it, use `bash linux/install-client.sh '/path/to/instance/game-folder' '/path/to/autosell-bridge.json'` from the app folder. Keep that graphical session running when disconnecting. Use one live delivery backend for a given seller account.

To share the app again, send the clean ZIP. Your working application folder contains your vault, browser login, pairing configuration and order records.

For the pricing settings under **Offers and stock**, see [How Autosell prices DonutSMP offers](COMPETITOR-PRICING-PLAN.md). The guide covers existing offers, automatically created offers and the proposed Gemini pricing assistant.

To see current asking prices, link your listing, then click **Compare competitor prices** under **Existing currency offer**. The preview compares other Active USD offers that can fill your minimum order and shows their stock and price per million.
