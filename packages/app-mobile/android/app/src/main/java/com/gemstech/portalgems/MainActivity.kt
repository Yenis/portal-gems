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

  // "Share -> PortalGems" from other apps. The URI is parked here and JS pulls
  // it via PortalGemsNative.consumePendingShare (polled on mount and on
  // AppState becoming active) — no event-emitter plumbing needed.
  private fun captureShare(intent: Intent?) {
    if (intent?.action != Intent.ACTION_SEND) return
    @Suppress("DEPRECATION")
    val uri: Uri? =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
      } else {
        intent.getParcelableExtra(Intent.EXTRA_STREAM)
      }
    if (uri != null) {
      pendingShareUri = uri.toString()
    }
  }

  companion object {
    @Volatile var pendingShareUri: String? = null
  }
}
