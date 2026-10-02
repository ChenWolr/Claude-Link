// provider-store.ts
// 供应商模型库的渲染层只读投影：设置页（可选项库的维护现场）与会话选择器（只读消费方）共用。
// 数据经 IPC 拉取（config:listProviders，apiKey 只有掩码），主进程 PROVIDERS_CHANGED 推送刷新。
// 会话选择器显示用 resolveSessionModel（shared 纯函数）与主进程 spawn 注入同源，避免两端不一致。

import { defineStore } from 'pinia';
import type { ModelInfo, ProviderModel, ProviderProfileView, ProviderSaveInput } from '../../shared/types/config';
import { resolveSessionModel, type ProviderModelSource, type ResolvedSessionModel } from '../../shared/session-model';

export const useProviderStore = defineStore('provider', {
  state: () => ({
    providers: [] as ProviderProfileView[],
    lastUsedProviderId: null as string | null,
    lastUsedModelId: null as string | null,
    loaded: false,
    loading: false,
    error: null as string | null,
  }),
  getters: {
    // 会话模型解析输入（shared 纯函数要求的形状；渲染层无密钥，apiKey 为空串不影响 ID/模型解析）。
    sources(state): ProviderModelSource[] {
      return state.providers.map((p) => ({
        id: p.id,
        name: p.name,
        apiBaseUrl: p.apiBaseUrl,
        apiKey: '',
        models: p.models,
      }));
    },
    // 与主进程 spawn 同一解析（会话 override > 最近使用 > 库首）。
    resolve(): (selection: { providerOverride: string | null; modelOverride: string | null }) => ResolvedSessionModel {
      return (selection) =>
        resolveSessionModel(
          selection,
          { providerId: this.lastUsedProviderId, modelId: this.lastUsedModelId },
          this.sources,
        );
    },
  },
  actions: {
    async load() {
      this.loading = true;
      this.error = null;
      try {
        const snapshot = await window.claudeLink.listProviders();
        this.providers = snapshot.providers;
        this.lastUsedProviderId = snapshot.lastUsedProviderId;
        this.lastUsedModelId = snapshot.lastUsedModelId;
        this.loaded = true;
      } catch (error) {
        this.error = error instanceof Error ? error.message : '加载供应商列表失败';
      } finally {
        this.loading = false;
      }
    },
    // 首次用到时拉取 + 订阅主进程变更推送（幂等；返回取消订阅函数）。
    ensureLoaded(): () => void {
      if (!this.loaded && !this.loading) void this.load();
      return window.claudeLink.onProvidersChanged(() => {
        void this.load();
      });
    },
    // hb10 P2-3：无条件重拉快照（与 load() 共用实现，刷新 providers/lastUsed/loaded）——
    // 主进程「最近使用」在会话选用等场景变更后，选择器读侧/写侧经此同步显示态。
    // 不带 loaded 短路（区别于 ensureLoaded）；每次切会话/选模型至多一次 IPC，量级可接受。
    async ensureReload(): Promise<void> {
      await this.load();
    },
    async save(input: ProviderSaveInput): Promise<ProviderProfileView> {
      // Pinia 状态中的 models 可能包含响应式代理；Electron IPC 结构化克隆无法处理代理。
      // 在 renderer → preload 边界前显式转成纯对象，避免多模型保存时报克隆错误。
      const plainInput = JSON.parse(JSON.stringify(input)) as ProviderSaveInput;
      const view = await window.claudeLink.saveProvider(plainInput);
      await this.load();
      return view;
    },
    async remove(providerId: string): Promise<void> {
      await window.claudeLink.deleteProvider(providerId);
      await this.load();
    },
    async restoreDeleted(): Promise<ProviderProfileView> {
      const view = await window.claudeLink.restoreProvider();
      await this.load();
      return view;
    },
    // A5（D02-F1）：模型列表写时重算——fn 在保存执行时刻基于 store 最新 models 应用（而非
    // 调用方点击时的快照），整表替换语义下串行链交错的「后写」不再覆盖「先写」。fn 收到的是
    // 去代理纯数组（IPC 结构化克隆安全）；档案字段（name/note/apiBaseUrl）同刻现取最新，
    // 与编辑保存并发时不回盖其他字段。
    async updateProviderModels(
      providerId: string,
      fn: (latest: ProviderModel[]) => ProviderModel[],
    ): Promise<ProviderProfileView> {
      const latest = this.providers.find((p) => p.id === providerId);
      const models = fn(JSON.parse(JSON.stringify(latest?.models ?? [])) as ProviderModel[]);
      return this.save({
        id: providerId,
        name: latest?.name ?? '',
        note: latest?.note,
        apiBaseUrl: latest?.apiBaseUrl ?? '',
        models,
      });
    },
    async queryModels(providerId: string, forceRefresh = false): Promise<ModelInfo[]> {
      return window.claudeLink.queryProviderModels(providerId, forceRefresh);
    },
  },
});
