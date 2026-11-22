package com.delpheye.companion

import android.Manifest
import android.app.Activity
import android.content.Context
import android.net.wifi.WifiManager
import android.os.SystemClock
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * The Wi-Fi the phone hears, from Android's WifiManager. Android hands out scan results only to
 * apps with the location permission, and limits how often a scan may be started (4 per 2 minutes
 * unless "Wi-Fi scan throttling" is off in the developer options); between scans the last results
 * come back, with their age.
 */
@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION], alias = "location"),
    ],
)
class WifiPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun scan(invoke: Invoke) {
        val wm = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        @Suppress("DEPRECATION")
        val started = try { wm.startScan() } catch (e: Exception) { false }
        val now = SystemClock.elapsedRealtime() * 1000
        val results = JSArray()
        val list = try { wm.scanResults } catch (e: SecurityException) { emptyList() }
        for (r in list) {
            val o = JSObject()
            o.put("bssid", r.BSSID ?: "")
            @Suppress("DEPRECATION")
            o.put("ssid", r.SSID ?: "")
            o.put("rssi", r.level)
            o.put("freq", r.frequency)
            o.put("age", (now - r.timestamp) / 1000)
            results.put(o)
        }
        val ret = JSObject()
        ret.put("started", started)
        ret.put("results", results)
        @Suppress("DEPRECATION")
        val info = wm.connectionInfo
        if (info != null && info.networkId != -1) {
            ret.put("linkBssid", info.bssid)
            ret.put("linkRssi", info.rssi)
        }
        invoke.resolve(ret)
    }
}
