package com.gemstech.portalgems

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  override fun getMainComponentName(): String = "PortalGems"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    captureShare(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    captureShare(intent)
  }

  // "Share -> PortalGems" from other apps: one file (ACTION_SEND) or several
  // selected together in a gallery or file manager (ACTION_SEND_MULTIPLE).
  // The URIs are parked here and JS pulls them via
  // PortalGemsNative.consumePendingShare (polled on mount and on AppState
  // becoming active) - no event-emitter plumbing needed. A share that
  // carries no file - plain text, say - is not ours and is left alone.
  private fun captureShare(intent: Intent?) {
    val uris: List<Uri> = when (intent?.action) {
      Intent.ACTION_SEND -> listOfNotNull(sharedStream(intent))
      Intent.ACTION_SEND_MULTIPLE -> sharedStreams(intent)
      else -> return
    }
    // Any app can aim a share at this activity, and what it names is read
    // with this app's own access. A `file://` URI can therefore point at
    // this app's private files - its settings, its cache - and have them
    // sent on. Only `content://` is taken: that is read through the other
    // app's provider, with the other app's access, which is what sharing
    // means. PortalGemsNativeModule.sendableUri checks again at the read.
    val sendable = uris.filter { it.scheme == "content" }
    if (sendable.isNotEmpty()) {
      pendingShareUris = sendable.map { it.toString() }
    }
  }

  @Suppress("DEPRECATION")
  private fun sharedStream(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
    }

  @Suppress("DEPRECATION")
  private fun sharedStreams(intent: Intent): List<Uri> {
    val list: ArrayList<Uri>? =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
      } else {
        intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
      }
    // Senders are free to put nulls in the list.
    return list?.filterNotNull() ?: emptyList()
  }

  companion object {
    @Volatile var pendingShareUris: List<String> = emptyList()
  }
}
