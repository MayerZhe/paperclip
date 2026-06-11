/**
 * electron-builder afterPack hook — Fix Electron Helper Info.plist
 *
 * Problem: electron-builder (v23+) adds CFBundleDisplayName + CFBundleExecutable
 * to each Helper .app inside Contents/Frameworks/. On macOS, CFBundleDisplayName
 * causes Launch Services to register the Helper as a named, displayable application
 * — even though LSUIElement=true — resulting in 4 extra "PaperClip Helper" icons
 * in Launchpad and/or Dock.
 *
 * This hook mirrors what VS Code does: strip CFBundleDisplayName and
 * CFBundleExecutable from all Helper Info.plist files, keeping only
 * LSUIElement=true + the minimal keys macOS needs to launch the helper binary.
 *
 * Reference: VS Code helpers only have CFBundleIdentifier, CFBundleName,
 * CFBundlePackageType=APPL, LSUIElement=true, LSEnvironment, and
 * NSSupportsAutomaticGraphicsSwitching.
 */

const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

exports.default = async function (context) {
  const appOutDir = context.appOutDir;
  const appName = context.packager.appInfo.productName;
  const frameworksDir = path.join(
    appOutDir,
    `${appName}.app`,
    "Contents",
    "Frameworks",
  );

  if (!fs.existsSync(frameworksDir)) {
    console.log("[fix-helper-plist] Frameworks dir not found, skipping");
    return;
  }

  let fixed = 0;
  const entries = fs.readdirSync(frameworksDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.name.includes("Helper") || !entry.name.endsWith(".app")) continue;

    const plistPath = path.join(
      frameworksDir,
      entry.name,
      "Contents",
      "Info.plist",
    );
    if (!fs.existsSync(plistPath)) continue;

    console.log(`[fix-helper-plist] Fixing: ${entry.name}`);

    // 1. Remove CFBundleDisplayName — this is the KEY change.
    //    Its presence causes Launch Services to treat the helper as a
    //    named, user-visible application.
    try {
      execSync(
        `/usr/libexec/PlistBuddy -c "Delete :CFBundleDisplayName" "${plistPath}"`,
        { stdio: "pipe" },
      );
      console.log(`  ✓ Removed CFBundleDisplayName`);
    } catch {
      /* key already absent — no-op */
    }

    // 2. Remove CFBundleExecutable — VS Code helpers don't have it either.
    //    The executable is resolved via the .app bundle structure,
    //    not from this plist key.
    try {
      execSync(
        `/usr/libexec/PlistBuddy -c "Delete :CFBundleExecutable" "${plistPath}"`,
        { stdio: "pipe" },
      );
      console.log(`  ✓ Removed CFBundleExecutable`);
    } catch {
      /* key already absent — no-op */
    }

    // 3. Ensure LSUIElement = true (should already be set by electron-builder,
    //    but this is defense-in-depth).
    try {
      execSync(
        `/usr/libexec/PlistBuddy -c "Delete :LSUIElement" "${plistPath}"`,
        { stdio: "pipe" },
      );
    } catch {
      /* key doesn't exist yet */
    }
    execSync(
      `/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "${plistPath}"`,
      { stdio: "pipe" },
    );
    console.log(`  ✓ LSUIElement = true`);

    fixed++;
  }

  console.log(`[fix-helper-plist] Done — fixed ${fixed} Helper(s)`);
};
