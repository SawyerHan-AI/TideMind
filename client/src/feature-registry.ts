/**
 * Pro 功能注册表
 *
 * 动态加载闭源客户端功能（路由、侧边栏、i18n 等）。
 * pro/client-features 不存在时返回 null——开源版正常运行。
 */

import type { RouteObject } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'

export interface SidebarItem {
  to: string
  icon: LucideIcon
  label: string
}

export interface ProFeatures {
  routes: RouteObject[]
  sidebarItems: SidebarItem[]
}

let proFeatures: ProFeatures | null = null

export async function loadProFeatures(): Promise<ProFeatures | null> {
  try {
    // 用变量拼接路径，避免 Vite 静态分析时报错（文件不存在是正常的——开源版）
    const base = '../../pro/client-features'
    const mod = await import(/* @vite-ignore */ `${base}/routes.js`)
    proFeatures = mod.default as ProFeatures
    return proFeatures
  } catch {
    // pro/client-features 不存在 → 开源版
    return null
  }
}

export function getProFeatures(): ProFeatures | null {
  return proFeatures
}
