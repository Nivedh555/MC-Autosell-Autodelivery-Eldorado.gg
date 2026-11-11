# Windows signing options

Checked 11 November 2026. Prices below are published USD prices before tax, exchange-rate changes, shipping and optional services. Confirm the final provider quote and country eligibility before buying. A certificate proves the publisher identity; it is separate from Autosell's Ed25519 update-manifest signature.

## Costs and eligibility

| Option | Published starting cost | Fit for Autosell |
| --- | --- | --- |
| Microsoft Azure Artifact Signing (formerly Trusted Signing) | Basic: $9.99/month, 5,000 signatures/month; additional signatures $0.005 each | Cloud signing suitable for GitHub-hosted Windows builds if the publisher qualifies. |
| SSL.com Individual Validated certificate with eSigner | Certificate: $129 for one year. IV/OV eSigner Tier 1: $20/month, or $180/year, for the published allowance. Combined annual baseline: $309 if paying the signing subscription annually. | An option for an individual publisher without a registered company; confirm country acceptance and CI signing limits with SSL.com. Requires its cloud signing integration, not a PFX download. |
| SSL.com IV certificate with a physical token | Certificate: $129/year; listed token add-on: $379, plus shipping/taxes | Requires a controlled signing machine with the token. A USB token cannot be plugged into an ordinary GitHub-hosted runner. |
| SignPath Foundation | Free for approved open-source projects | Approval and an OSI-approved license are required. This repository currently declares `UNLICENSED`; being public on GitHub alone does not qualify. Do not change the license solely to claim eligibility without the copyright owners' agreement. |

Sources: [Azure pricing](https://azure.microsoft.com/en-us/products/artifact-signing), [SSL.com IV pricing](https://www.ssl.com/products/software-integrity/code-signing/iv/), [eSigner subscription pricing](https://www.ssl.com/guide/esigner-pricing-for-code-signing/), [SignPath conditions](https://signpath.org/terms).

Azure's current public-trust eligibility covers organizations in the US, Canada, EU, UK, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway and Israel. Individual applicants must be in the US or Canada. India is not on that list. If your legal identity is based in India, do not buy Azure expecting that it can issue a public-trust certificate for you; obtain confirmation from Microsoft first. Private-trust signing is not a substitute for a publicly trusted Windows installer. [Microsoft eligibility and setup](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart).

Modern publicly trusted code-signing keys are normally protected in supported hardware or a cloud HSM. An ordinary exportable PFX may not be offered by a new provider. The repository's PFX route is only for a valid, legitimately supplied compatible signing identity. Never export a hardware-protected key to work around the provider's requirements. SSL.com documents its token/cloud issuance requirement in its [eSigner guide](https://www.ssl.com/guide/esigner-pricing-for-code-signing/).

## Repository setup

Follow [the release setup instructions](RELEASE-SETUP.md) for the exact implemented provider configuration, environment variable names and release commands. The existing `windows-release` environment is the approval boundary. The workflow must fail if signing is unconfigured, if Authenticode verification fails, or if the update manifest does not match the installer.

Azure is the directly supported cloud path. SSL.com and SignPath are alternatives to evaluate, not configured integrations in this checkout. Their provider-specific account setup and signing hook must be implemented and tested before selecting them for a release. Do not put their credentials into the PFX secrets or assume they are interchangeable with Azure.

Use the exact validated certificate subject for `AUTOSELL_PUBLISHER_NAME`; do not invent a publisher name. Keep Windows signing credentials and the Ed25519 manifest private key in protected GitHub environment secrets. The app contains only public verification material.

## What can be tested without purchasing a certificate

The existing development build tests packaging, isolated installed startup, data retention, uninstall behavior, update UI, manifest validation, download state, and payment maintenance guards. Those tests do not prove a published signed automatic upgrade.

A self-signed laboratory certificate can be appropriate only inside a disposable VM with a separate app identity, separate feed and separate keys. Trusting it there would establish laboratory trust only. It must never be imported into users' trust stores, embedded as the production publisher, or published on the production update channel. No trusted publisher has been fabricated and no machine trust store has been changed for this project.

Production acceptance still requires two real signed published versions and a packaged older application that downloads, verifies, safely installs and launches the newer version while preserving its database and journals. The repository's upgrade acceptance workflow records this result; a green ordinary build is not evidence that automatic updates have passed.
