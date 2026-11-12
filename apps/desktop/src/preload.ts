/**
 * Runs in the sandboxed renderer before the web app. Exposes only a read-only
 * flag so the UI can tell it is running on the desktop. No Node APIs, no IPC.
 */
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('constructosDesktop', Object.freeze({ isDesktop: true, platform: process.platform }));
