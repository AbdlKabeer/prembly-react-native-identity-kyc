package com.prembly.device

/**
 * Packages of remote-access and screen-sharing apps that scammers ask victims to install.
 *
 * REVIEW REQUIRED before release: this list, and the matching `<queries>` entries in the manifest,
 * decide which packages the SDK may look for. Keep both in step, keep the list short, and be ready to
 * justify package visibility in the Google Play review.
 */
internal object RemoteAccessApps {
  val PACKAGES: Set<String> =
    linkedSetOf(
      "com.anydesk.anydeskandroid",
      "com.anydesk.adcontrol.ad1",
      "com.teamviewer.teamviewer.market.mobile",
      "com.teamviewer.quicksupport.market",
      "com.teamviewer.host.market",
      "com.carriez.flutter_hbb",
      "com.sand.airdroid",
      "com.sand.airmirror",
    )

  /** Root managers, checked only to help spot a rooted device. */
  val ROOT_MANAGER_PACKAGES: Set<String> =
    linkedSetOf(
      "com.topjohnwu.magisk",
      "eu.chainfire.supersu",
      "com.koushikdutta.superuser",
      "com.noshufou.android.su",
      "me.weishu.kernelsu",
    )
}
