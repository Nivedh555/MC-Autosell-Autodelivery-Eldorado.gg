# Minecraft delivery setup

Use **AutoSell Pairs → Minecraft delivery clients → Set up Minecraft in Prism**. Keep Autosell and Minecraft on the same computer. The current bridge uses Minecraft Java **26.3**, Fabric Loader **0.20.1**, and Java **25**.

1. Install Prism Launcher and open it once. Complete its first-run setup. In **Accounts → Manage Accounts → Add Microsoft**, sign in with the Microsoft account that owns Minecraft Java. Check the exact Minecraft name displayed for that account.
2. In Autosell, open **AutoSell Pairs**. Under **Set up Minecraft in Prism**, click **Refresh Prism folders**. Choose your Prism folder. For portable Prism or a custom location, use **Folders → Launcher Root** in Prism, then paste that full path into **Use a portable or different Prism folder**.
3. Leave **Create Autosell Delivery instance** selected for a dedicated client, or select an existing compatible instance. Choose the delivery account slot, usually **seller1**, and enter its exact Minecraft IGN.
4. Close that Minecraft instance. Check **I have closed this Minecraft instance**, then click **Install mods and pair**. Autosell creates the instance if needed, checks both packaged mod hashes, installs the bridge and Fabric API, and saves the pairing in that instance’s game folder.
5. In Prism **Settings → Java**, enable automatic Java detection and Mojang Java downloads. If your Linux Prism package requires a manually installed runtime, choose Java 25. Reopen Prism if the new instance has not appeared. Select the instance named in Autosell’s success message, choose the same Minecraft account, and click **Launch**.
6. In Minecraft choose **Multiplayer → Direct Connection → donutsmp.net**. Wait for your account to show **Online** in Autosell. Keep the game open during delivery.
7. In **Eldorado Setup**, connect your seller browser, link the offer to this same account slot, and use **Check startup**. The readiness panel shows any remaining stock, offer, or automation action.

The Microsoft sign-in happens in Prism. Autosell setup uses your exact IGN and its own local bridge pairing. Later starts reuse the same installed instance and pairing file.

## If setup needs attention

- **No Prism folders detected** — finish Prism’s first-run setup and refresh, or add the root folder using Prism’s **Folders → Launcher Root** menu. Standard Windows, Scoop, Linux and Flatpak data locations are detected automatically.
- **Different Minecraft or Fabric version** — choose **Create Autosell Delivery instance**. Existing instances remain available in Prism.
- **Existing mod or pairing conflicts** — choose a dedicated instance. Setup preserves the existing file and explains the conflict.
- **Game says online but Autosell is waiting** — check that the launched instance contains both mods and `config/autosell-bridge.json`, the exact selected account matches the pairing, you joined the configured server, and Autosell is running on the same computer. Close and relaunch the game after installing the mods.
- **Setup was interrupted** — close the game and run the same installation again. Identical installed mods and the current backend pairing are reused. A different pairing file is preserved and requires choosing another instance.
- **Pair has an active or unresolved order** — finish or reconcile that order in Autosell before changing its game setup.

Official Prism instructions cover [data locations](https://prismlauncher.org/wiki/getting-started/data-location/), [instance creation](https://prismlauncher.org/wiki/getting-started/create-instance/) and [Java setup](https://prismlauncher.org/wiki/getting-started/installing-java/).

## Implementation and validation

The authenticated dashboard uses `/api/v3/game/onboarding`. File changes require the same owner reauthentication as the existing pairing endpoint. Instance choices are resolved from detected roots, with exact version checks, path containment, linked-file rejection, exclusive writes, and SHA-256 verification against the bundled `release/SHA256SUMS`. Pairing tokens stay in the encrypted vault and the local game configuration, and are excluded from onboarding responses. Downloads of Minecraft, Fabric Loader, and Java run through Prism during its normal launch flow.

The automated tests exercise temporary Windows-style and Linux-style roots, a Flatpak root, existing and new instances, tampered mods, path traversal and linked directories, existing-file preservation, interrupted retries, connected clients, active order locks, authenticated routes and the shipped dashboard. They do not launch Minecraft or perform a live delivery. A clean-machine Prism launch and Microsoft account sign-in still require an interactive user session.
