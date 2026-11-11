# Release setup

This is the implemented release contract for Autosell V3. Read [SIGNING-OPTIONS.md](SIGNING-OPTIONS.md) first; it records provider costs, country eligibility and the limits of self-signed laboratory testing. No certificate is included in this repository and no publisher identity is invented.

## 1. Protect the release environment

Create the GitHub environment `windows-release`. Add required reviewer `Nivedh555` and a deployment policy limited to tags matching `v*`. The release job is the only job that receives signing material. Keep all signing secrets in that environment, not in repository-level secrets or committed files.

The workflow requires all of the following to agree before publication:

- tag `v<package version>` and the version in both root and `desktop/package.json`;
- beta suffix and channel (`3.1.0-beta.1` uses `beta`, otherwise `stable`);
- exact certificate publisher identity;
- non-empty signed release notes;
- installer filename, size and SHA512 in the generated update metadata;
- a valid Authenticode signature on the installer and installed application;
- a valid Ed25519 signature over the release manifest.

A mismatch stops the job before upload. A green development build is not a signed release.

## 2. Provision the Ed25519 update key pair

The update manifest is independent of the Windows certificate. Generate an Ed25519 pair on an approved workstation:

```powershell
openssl genpkey -algorithm ED25519 -out update-private.pem
openssl pkey -in update-private.pem -pubout -out update-public.pem
```

Store the private key only as the environment secret `AUTOSELL_UPDATE_PRIVATE_KEY`. Store the public key as the environment variable `AUTOSELL_UPDATE_PUBLIC_KEY`. Remove transient plaintext copies according to your key-handling procedure. The app contains only the public key. Losing the private key prevents future signed updates; leaking it lets an attacker sign a malicious manifest, so rotate it deliberately and publish a new release signed by the new key.

`desktop/scripts/configure-release.js` verifies that the pair matches and that both keys are Ed25519 before packaging.

## 3. Choose one implemented Windows signing path

Set the environment variable `AUTOSELL_SIGNING_PROVIDER` to `pfx` or `azure`. Only these two paths are implemented in `electron-builder.config.js` with the pinned electron-builder 26.18.0.

### PFX

Use this only for a legitimately supplied, exportable PFX that the provider permits on CI. A hardware-protected key must not be exported to make this path work.

| Name | Type | Value |
| --- | --- | --- |
| `AUTOSELL_PUBLISHER_NAME` | Environment variable | Exact certificate subject common name or full distinguished name |
| `WINDOWS_CERTIFICATE_PFX_BASE64` | Environment secret | Base64 encoded PFX |
| `WINDOWS_CERTIFICATE_PASSWORD` | Environment secret | PFX password |

### Azure Artifact Signing (formerly Trusted Signing)

Azure is the supported cloud path. The pinned electron-builder invokes its `TrustedSigning` PowerShell module. That module authenticates with Azure Identity environment credentials; it does not consume a GitHub OIDC token directly. Use a protected service principal secret, or run the signing step on a controlled self-hosted runner with an equivalent Azure identity. Do not claim GitHub OIDC support for this pinned path unless you have tested the exact module and identity combination.

| Name | Type | Value |
| --- | --- | --- |
| `AUTOSELL_SIGNING_PROVIDER` | Environment variable | `azure` |
| `AUTOSELL_PUBLISHER_NAME` | Environment variable | Exact certificate publisher identity |
| `AZURE_SIGNING_ENDPOINT` | Environment variable | Azure Artifact Signing account endpoint, HTTPS only |
| `AZURE_SIGNING_ACCOUNT` | Environment variable | Code signing account name |
| `AZURE_SIGNING_PROFILE` | Environment variable | Certificate profile name |
| `AZURE_TENANT_ID` | Environment variable | Microsoft Entra tenant ID |
| `AZURE_CLIENT_ID` | Environment variable | Service principal application ID |
| `AZURE_CLIENT_SECRET` | Environment secret | Service principal secret |

Azure public-trust eligibility is limited by legal location. Individuals must be in the US or Canada; India is not on Microsoft's published public-trust list. Confirm eligibility before buying. Private-trust signing does not make a public installer trusted. See [SIGNING-OPTIONS.md](SIGNING-OPTIONS.md).

### Other providers

SSL.com eSigner and SignPath are documented alternatives, not configured integrations. Their account setup, signing hook and artifact verification must be implemented and tested before use. Do not put their credentials into the PFX secrets or assume they are interchangeable with Azure.

## 4. Publish a release

1. Set the same version in `package.json`, `desktop/package.json`, and both lockfiles.
2. Commit the validated source and push `main`. Confirm the development workflow passes.
3. Create and push the tag, for example `v3.0.1` (stable) or `v3.1.0-beta.1` (beta).
4. Approve the `windows-release` deployment after reviewing the tag and commit.
5. The job validates, stages resources, signs, verifies Authenticode and publisher identity, runs the installer lifecycle test, generates release notes, signs the manifest and uploads the draft release.

Stable releases publish `latest.yml` and `stable-manifest.json`; beta releases publish `beta.yml` and `beta-manifest.json` as a GitHub prerelease. Each manifest binds channel, version, publisher, release notes, installer name, size and SHA512.

## 5. Verify the result

Download the published installer from the release and check:

```powershell
Get-AuthenticodeSignature .\Autosell-Setup-3.0.1-x64.exe | Format-List Status, SignerCertificate
Get-FileHash .\Autosell-Setup-3.0.1-x64.exe -Algorithm SHA256
```

Compare the SHA256 with `SHA256SUMS` and confirm the signer subject matches `AUTOSELL_PUBLISHER_NAME`. A development build remains unsigned and cannot exercise the production feed.

## 6. Real A-to-B acceptance

A real signed automatic upgrade requires two published signed versions. Use the manual **Windows signed update acceptance** workflow with the older and newer tags after both releases exist. It installs the older signed build on a disposable runner, drives its normal **Check for updates**, downloads and verifies the newer release, installs and relaunches, and checks that the workspace database and journals survive. A packaged unsigned installer test, same-version replacement or mocked update check does not satisfy this acceptance.

Until that job passes, do not claim that production auto-update works. The first official signed build must be installed manually by users on the unsigned development build.
