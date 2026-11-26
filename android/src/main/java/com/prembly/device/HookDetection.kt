package com.prembly.device

import java.io.File
import java.net.InetSocketAddress
import java.net.Socket

/**
 * Best-effort detection of hooking and instrumentation frameworks (Frida, Xposed, LSPosed,
 * Substrate) inside this process. Every check here is something a determined attacker can hide
 * from, so a "true" is strong evidence and a "false" is not proof. Each check fails soft: an
 * unreadable file or a refused probe counts as "not found", never as an error.
 */
internal object HookDetection {
  /** Lower-case fragments of names that only show up when a hooking tool is loaded. */
  private val MAP_MARKERS =
    listOf(
      "frida",
      "linjector",
      "xposed",
      "lsposed",
      "edxposed",
      "riru",
      "zygisk",
      "libsubstrate",
      "substrate",
    )

  private val XPOSED_CLASSES =
    listOf(
      "de.robv.android.xposed.XposedBridge",
      "de.robv.android.xposed.XC_MethodHook",
    )

  private const val FRIDA_DEFAULT_PORT = 27042
  private const val PORT_PROBE_TIMEOUT_MS = 100

  fun isHookingFrameworkDetected(): Boolean =
    hasMappedMarker() || hasXposedClass() || hasXposedInStack() || isFridaPortOpen()

  /** Libraries and threads mapped into the process: where an injected agent shows up. */
  private fun hasMappedMarker(): Boolean =
    runCatching {
        File("/proc/self/maps").useLines { lines ->
          lines.any { line ->
            val lower = line.lowercase()
            MAP_MARKERS.any { lower.contains(it) }
          }
        }
      }
      .getOrDefault(false)

  /** Frida names its worker threads; they are listed in /proc/self/task/<tid>/comm. */
  private fun hasFridaThread(): Boolean =
    runCatching {
        File("/proc/self/task").listFiles()?.any { task ->
          val comm = File(task, "comm").readText().trim().lowercase()
          comm.contains("gum-js-loop") || comm.contains("gdbus") || comm.contains("frida")
        } ?: false
      }
      .getOrDefault(false)

  private fun hasXposedClass(): Boolean =
    XPOSED_CLASSES.any { name ->
      runCatching { Class.forName(name, false, ClassLoader.getSystemClassLoader()) }.isSuccess
    }

  /** Xposed rewrites call stacks: its bridge frames appear in any trace taken inside the app. */
  private fun hasXposedInStack(): Boolean =
    runCatching { throw Exception("tm_hook_probe") }
      .exceptionOrNull()
      ?.stackTrace
      ?.any {
        it.className.contains("de.robv.android.xposed", ignoreCase = true) ||
          it.className.contains("lsposed", ignoreCase = true) ||
          it.className.contains("EdHooker", ignoreCase = true)
      } ?: false

  /** The default frida-server port, open on localhost. Probed with a short timeout. */
  private fun isFridaPortOpen(): Boolean =
    hasFridaThread() ||
      runCatching {
          Socket().use { socket ->
            socket.connect(InetSocketAddress("127.0.0.1", FRIDA_DEFAULT_PORT), PORT_PROBE_TIMEOUT_MS)
            true
          }
        }
        .getOrDefault(false)
}
