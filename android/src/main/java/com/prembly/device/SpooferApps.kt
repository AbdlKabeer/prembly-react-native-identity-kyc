package com.prembly.device

/**
 * The names the extended signals look for. Android 11+ only lets an app see a package it names in
 * its manifest `<queries>`, so every entry here is also listed there, and the SDK does not use
 * QUERY_ALL_PACKAGES. The lists are a starting point: a clone or spoofing app that is not on one
 * is not seen by name, which is why the checks also look at behaviour.
 */
internal object SpooferApps {
  /** Mock-location apps. One only counts when it has also been chosen as the mock-location provider. */
  val GPS_SPOOFERS =
    listOf(
      "com.lexa.fakegps",
      "com.incorporateapps.fakegps.fre",
      "ru.gavrikov.mocklocations",
      "com.theappninjas.gpsjoystick",
    )

  /** Auto-clicker apps (an unlisted one is still caught when its accessibility service can tap). */
  val AUTO_CLICKERS = listOf("com.truedevelopersstudio.automatictap.autoclicker")

  /** Parallel-space and cloning hosts, matched against the app's data directory. */
  val CLONE_HOSTS = listOf("/virtual/", "/parallel/", "/dualspace/", "/clone/")

  /** Names that show up in the process map or the build fields of a virtual machine app. */
  val VIRTUAL_OS_MARKERS = listOf("vmos", "virtualapp", "va_native", "libvirtual", "io.va.exposed")

  /** Network interface names of a tunnel (a VPN, whether or not the system says so). */
  val TUNNEL_PREFIXES = listOf("tun", "ppp", "pptp", "ipsec")
}
