// scripts/tdd-engine-expansion-verify.ts
// 翻译引擎扩容与清理批次行为卷（2026-11-22 批次 · 00-行为契约与实施计划 E1 卷位）。
// 本卷由点 p1（W1 bing-web 复活）创建；点 p2（W2a alibaba-web 移植）扩容追加 alibaba 纯函数
// 固定向量组；点 p3（W2b qq-transmart）扩容 qq 纯函数组；点 p4（W2c sogou-web）扩容 sogou
// 纯函数组；点 p5（W2d youdao-web V2 重写）扩容 youdao 纯函数与固定向量组；点 p6（W5 注册/
// 付费层整链移除）扩容 tencent-tmt + custom-template 删净负向钉组（EX-P6-1..4）；点 p7（W4）
// 扩容死引擎清理负向结构钉组（EX-P7 组）；点 p8（P1-B/P2-1/P2-2）扩容代理回撤 + UX 行为组
// （EX-P8 组 + RB-MT-T36/T37）；round-002 C-1 修复（2026-11-22）扩容 loopback 行为组终态收口
// （01 清单 §1-§5 整行 23 条 + 半面 8 条 + EX-P7-2b/EX-P2D-12b/RB-MT-T37b 同场补——至此本卷
// 为 01 清单 E1 卷位全量承载卷，无待扩容面）。
//
// 出卷依据：01-测试用例清单.md §1（P1 bing 组 EX-P1-*）；协议事实 = 09-bing复活发现与修复方案
// §2/§3/§5 只读采纳（TS 独立实现，零 GPL 代码拷贝进仓库）。
//
// 卷形态（沿 tdd-message-translate-verify 手法）：translation-engines 整模块 TS→CJS 转译入 vm，
// logger/electron 替 stub、translation-core 直跑真身；本组纯函数面零网络零缓存副作用。
//
// 用例映射（check 计数，失败 exit 1）：
//   EX-P1-12  parseBingSessionHtml 导出且可独立调用（「页面→会话三件套提为可测纯函数」契约本体）
//   EX-P1-1   数组形态：key=arr[0]（时间戳位，09 §2 差异1 根因）、token=arr[1]；旧 arr[2] 位
//             （有效期 ms）不得再作 key；字符串时间戳形态同容忍（String 化双形态）
//   EX-P1-2   旧对象形态 {key,token} 回落保留（防御旧页面回滚），产物语义与数组形态一致
//   EX-P1-3   双形态皆缺失 / params 在场但 data-iid 缺失 / 数组残缺 → null（不静默空值；
//             调用方按引擎失败降级，不挂起不发畸形请求）
//   EX-P1-4   data-iid="translator.504633" → 会话存数字 504633（前缀恰剥一次，防 URL 模板
//             translator. 双拼）+ URL 模板 IID=translator.${} 字面不动（结构面）
//   EX-P1-5   data-iid="504633" 纯数字 → 504633（不二次剥、不误伤）
//   EX-P1-6   ttranslatev3 form 含 tryFetchingGenderDebiasedTranslations:'true'（结构面；
//             loopback 捕获面已随本卷行为组扩容落卷——W1 点申报，round-002 C-1 终态收口）
//   EX-P1-7   BROWSER_UA 版本段 Chrome/141.0.0.0、无 Chrome/126 残留（结构面；全字面钉在
//             tdd-translate-p1-fix-verify P1C-T2 并行生效）
//   W1-结构钉  cache.iid += 1 自增删除（IID 改用页面值；页面→会话缓存复用/失效重取恰一次/
//             并发单飞行为面已随本卷行为组扩容落卷——W1 点申报，round-002 C-1 终态收口）
//   EX-P2A-2a parseAlibabaCsrfResponse 导出且固定响应 → 固定产物 {headerName,token}
//             （csrf 响应解析纯函数面；W2a 点新增）
//   EX-P2A-2b csrf 响应失败形态 → null：非 JSON / headerName 缺失 / token 缺失或非字符串
//             （不静默空值——调用方按引擎失败降级，不发畸形请求）
//   EX-P2A-2c alibabaTranslateFields csrf 请求装配固定向量：query/srcLang=en/tgtLang=zh/
//             _csrf=<token>/domain=general 五字段固定序
//   EX-P2A-2d buildMultipartBody 组装固定输入 → body 含五字段且无占位残留；boundary 隔离
//             可测（参数注入固定 boundary → 精确帧结构：每字段一个 part + 终止符）
//   EX-P2A-2e extractAlibabaTranslateText 固定向量：{success:true,data:{translateText}} → 译文
//   EX-P2A-2f translateText 失败形态 → null：success:false / data 缺失 / translateText 缺失/
//             空串/非字符串（空译文 ≠ 成功态；EX-P2A-4 的纯函数面）
//   EX-P2B-2a buildQqClientKey 固定向量：browser-firefox-110.0.0-Windows 10-{uuid}-{ts} 字面
//             模板（uuid/ts 注入 → 固定产物；W2b 点新增）
//   EX-P2B-2b qqSplitPayload 分句请求装配固定向量：header.fn=text_analysis + client_key 透传 +
//             normalize.merge_broken_line='false'（协议字面钉）
//   EX-P2B-2c parseQqSentenceList start/len 切原 text 固定向量（逐句切片、缺口不误并）
//   EX-P2B-4  parseQqSentenceList 缺失兜底面：sentence_list 缺失/空数组/要素残缺 → null，
//             组合装配 qqAutoTranslationPayload(parse ?? [整段]) → text_list=['', 整段, '']
//             （整段单句兜底契约钉的纯函数面）
//   EX-P2B-2d qqAutoTranslationPayload 装配固定向量：text_list=['']+分句+[''] 首尾空串、
//             source.lang=en、target.lang=zh（lang 字面钉，RB-MT-T11 qq 面）
//   EX-P2B-3  extractQqTranslation 去首尾空串拼接固定向量：['','句1','句2',''] → '句1句2'
//             （首尾空串去除、正文逐字保全；评审 P2-6）
//   EX-P2B-5  extractQqTranslation 全空串拼接 → null（空译文 ≠ 成功态，纯函数面）
//   EX-P2B-6  extractQqTranslation ret_code≠succ → null（纯函数面）
//   EX-P2B-7  extractQqTranslation auto_translation 缺失/非数组/非字符串元素 → null（纯函数面）
//   EX-P2C-2  sogouSign 导出且固定向量：md5("en"+"zh-CHS"+"hello"+"109984457") =
//             12544646d89537920c4c69ced977b2d7（出卷独立计算留痕，不触网可复算）+
//             from+to 拼接序敏感面 + secretCode 参数敏感面 + secretCode「109984457」常量
//             内建结构面（W2c 点新增）
//   EX-P2C-3  sogouTranslateForm form 装配固定向量：8 字段固定序（from=en/to=zh-CHS/text/
//             uuid/s/client=pc/fr=browser_pc/needQc=1）+ to=zh-CHS 字面钉（RB-MT-T11 sogou 面）
//   EX-P2C-4  extractSogouTranslation status≠0 → null（纯函数面；含 r2-F 收紧形态：
//             status:''/null 一律判失败——Number('')/Number(null) 归一 0 缝隙封堵，与 junk
//             非数字串同向；status:0 仍正常解析）
//   EX-P2C-5  extractSogouTranslation errorCode≠0 → null（纯函数面；errorCode:''/null 一律
//             判失败（r2-F 收紧同向）；errorCode:0 仍正常解析）
//   EX-P2C-6  extractSogouTranslation dit 缺失/空串/非字符串/中间层缺失 → null +
//             成功固定向量 data.translate.dit（评审 P2-6）
//   EX-P2D-2  youdaoSign 导出且双 sign 式固定向量（出卷独立计算留痕，不触网可复算）：
//             ①key 接口 defaultKey 版 md5("client=fanyideskweb&mysticTime=1700000000000&product=webfanyi
//             &key=webfanyi-key-getter-2025") = 8d477acb24abb7dd93e7618ac54caece；②translate 同式换
//             secretKey 版 md5("…mysticTime=1700000000001…&key=0123456789abcdef") = 3d42b8c6e706ea20457cdf760fd716ae
//             + 拼接模板敏感面（时间/key 改一位产物必异）；W2d 点新增
//   EX-P2D-2b youdaoKeyQuery key 接口查询装配固定向量：15 字段固定序（keyid/mysticTime/sign/client/
//             product/appVersion/vendor/keyfrom/pointParam/yduuid/mid/screen/model/network/abtest；
//             sign 字段即 EX-P2D-2① 固定向量）
//   EX-P2D-2c youdaoTranslateForm 翻译 POST form 装配固定向量：20 字段固定序（i/from=en/to=zh-CHS/
//             dictResult=true/useTerm=false + keyid=webfanyi 载荷 15 字段；sign 字段即 EX-P2D-2②；
//             to=zh-CHS 字面钉 = RB-MT-T11 youdao 面）
//   EX-P2D-2d 内建常量结构面：keyid 'webfanyi-key-getter-2025' / default key 实值 'yU5nT5dK3eZ1pI4j' /
//             decodeKey/decodeIv 'ydsecret://…' 兜底常量字面在 engines 源码（P2-3 常量内建；实值
//             = 2026-11-22 真网实测，申报见 W2d 申报段）
//   EX-P2D-3a youdaoAesSecretBytes 密钥派生定量向量：md5(input) 摘要 16 字节逐字节比对
//             （「md5 前 16 字节」= 16 字节摘要整体解释——实证配方申报口径，01 清单 §11.3-1）
//   EX-P2D-3b youdaoDecrypt base64url+AES-128-CBC 解密定量向量（不触网）：备选向量密文
//             rYFOyQjY36mtMJHNOlcuWL32xD-OzwB6drDmD5ezLoQnP5zAiEG6zS3D5Cu8wwhG8DBzDf9xpGxlqm7Gxunvvg
//             + aesKey='test-aes-key'/aesIv='test-aes-iv' → 明文 {"translateResult":[[{"tgt":"你好，世界。"}]]}
//             （派生错 = 解密必败，派生与解密由本向量横向钉死）
//   EX-P2D-6  youdaoDecrypt 失败形态 → null：空串/非法 base64url/坏密文（PKCS7 卸垫失败）
//             （解密失败不挂起不冒充成功；EX-P2D-6 纯函数面）
//   EX-P2D-4a extractYoudaoDefaultKey 固定向量：真网 js 形态 ="webfanyi-key-getter-2025",a="yU5nT5dK3eZ1pI4j";
//             → yU5nT5dK3eZ1pI4j + 出卷抽象形态 k="v" 容面 + js 无形态 → null（调用方内建兜底）
//   EX-P2D-4b extractYoudaoDecodeParts 固定向量：decodeKey/decodeIv 提取（真网实值形态）+
//             js 无形态 → null 双兜底（EX-P2D-4 decodeKey/decodeIv 兜底值源面）
//   EX-P2D-5  parseYoudaoKeyResponse：{data:{secretKey,aesKey,aesIv}} → 产物；secretKey 缺失/空/
//             非字符串/非 JSON/data 缺失 → null（EX-P2D-5 纯函数面）；aesKey/aesIv 缺省 → ''
//             （调用方内建兜底面）
//   EX-P2D-7  extractYoudaoTranslation：translateResult[[{tgt}]] 展平拼接固定向量（P2-6 逐字保全、
//             多行拼接）+ 缺失/空/残缺（行非数组/元素非对象/tgt 非字符串）→ null（EX-P2D-7 纯函数面；
//             空译文 ≠ 成功态）
//   EX-P2D-13 结构钉（V1 整函数删除）：translate_o / YOUDAO_KEY_DEFAULT / youdaoForm / youdaoKeyCache /
//             老 sign fanyideskweb${segment 拼接 / 老 key n%A-rKaT5fb / extractYoudaoKey( 字面零命中
//   EX-P2D-12 结构面（P1-5 endpoint 不消费）：makeYoudaoWeb 函数体 void ctx + ctx.entry.endpoint
//             与 DEFAULT_YOUDAO_WEB_ENDPOINT 零命中（youdao 段切片判定）
//   EX-P6-1   结构钉（W5 p6 · tencent 链删净）：makeTencentTmt/TC3 签名族（TC3-HMAC-SHA256/
//             tc3_request/hmacSha256/sha256Hex）/waitTencentInterval/tencentLastRequestAt/kind
//             'tencent-tmt'/TencentCredentials/tencentSecretId/tencentSecretKey/
//             tencentCredentialsBroken/TRANSLATION_TENCENT_*/DEFAULT_TENCENT_TMT_ENDPOINT/
//             tencentcloudapi/config-manager 凭据链（TENCENT_CREDENTIALS_KEY 独立键读写/
//             interceptTencentCredentialFields CONFIG_SAVE 拦截/getConfig 附加/掩码族）——
//             engines/service/core/config-manager/types/ConfigPage 六源码字面零命中
//             （config-manager 唯一豁免面 = P2-5 读路径清键字面，EX-P6-2 另钉）
//   EX-P6-2   存量 electron-store 键 translationTencentCredentials 一次性清键行为面（P2-5）：
//             store stub 携带该键 → config-manager getConfig 读路径读后键消失 + 二次读幂等
//             不报错 + delete 调用次数钉（round-002 B-1：stub 记录 deleteCalls——首读恰 1 次、
//             同一 store 连续二次读零 delete，conf@14.0.0 delete 对不存在键同样全量落盘 +
//             change 事件，无存在性守卫即热路径 IO 放大）+ 清键恰钉在读路径（代码面恰一处
//             delete 调用）而非 sanitize（sanitize 纯函数零 store 访问）；
//             凭据密文销毁不可逆（用户已知悉留痕）
//   EX-P6-3   结构钉（凭据表单/探面形态删净）：ConfigPage TranslationCredentialView import/
//             trTencentCredState/saveTencentCredentials/trSecretIdInput/trSecretKeyInput/
//             tr-cred 表单段/translate-tencent-cred-badge/「未配置凭据」「腾讯云凭据」文案零命中
//   EX-P6-4   结构钉（custom-template 链删净）：makeCustomTemplate/kind 'custom-template'/
//             TranslationCustomTemplate 类型/customTemplates 字段（含 service 落盘载荷键）/
//             templateName 引用链——六源码字面零命中 + ConfigPage 自定义模板编辑区与
//             「添加引擎」整块（trAddKind/addTranslationEngine/hasTencentEngine/
//             genTranslationEngineId/removeTranslationEngine/trTemplateForm 族）零命中
//
// p6 点范围申报（ex 正文同）：EX-P6-2 的 store stub = vm 装载真实 config-manager（stub 依赖 +
// 真实 sanitizeTranslationConfig + createSafeStore 垫片换卷侧持有的 stub store）——清键行为在
// 真实 getConfig 读路径上观测；unavailable 机械面保留休眠（评审 P2-7）零行为可断不出例，
// 实施以零 unreachable 告警自查、审查岗核。
//
// W1 点终态申报（ex 正文同；round-002 C-1 收口）：EX-P1-1/2/3 的 loopback 行为捕获半面落
// EX-P1-1c/2b/3b（ttranslatev3 携带捕获比对、对象形态全链、组降级 alibaba 接管 + 零畸形 POST）；
// EX-P1-8/9/10/11 落同名行为 check（三件套会话复用恰 1 次、token 失效重取恰一次双形态、并发
// 单飞、probe 429 恰重试一次判定双形态）。EX-P1-10 红核验：bing fetchBingToken 无 in-flight
// 共享 → 页面 GET 实得 3（双倍重抓）→ 修实现补 bingTokenFetch 单飞后绿（bing/alibaba 单飞补钉
// 为本轮唯一实现变更）。
//
// W2a 点终态申报（ex 正文同；round-002 C-1 收口）：EX-P2A-2 纯函数固定向量组随 p2 落卷；
// EX-P2A-1/3/4/5/6/7/8/9 落同名行为 check（三步链全链编排、csrf 500 组降级 qq 接管、success:false
// 降级、csrf 缓存恰 1 次、失败重取恰一次双形态、并发单飞、>5000 句末子切、endpoint 脏值出站不
// 消费——恒出厂域经 httpsShim 定向重写观测）。EX-P2A-7 红核验：alibaba fetchAlibabaCsrf 无
// in-flight 共享 → csrf GET 实得 3 → 修实现补 alibabaCsrfFetch 单飞后绿。
//
// W2b 点终态申报（ex 正文同；round-002 C-1 收口）：EX-P2B-2/3/4/5/6/7 纯函数面随 p3 落卷；
// EX-P2B-1/8/9/10 落同名行为 check（三步链编排、client_key 会话复用 Cookie 字面相同、预热并发
// 单飞、endpoint 脏值出站不消费）；EX-P2A-3（alibaba 败 → qq 接管的组语义面）由 EX-P2A-3 行为
// check（loopback 双端点）承载——tdd-message-translate W2b-2 stub 组为组语义面的 stub 侧镜像，
// 两面并存非替代。
//
// W2c 点终态申报（ex 正文同；round-002 C-1 收口）：EX-P2C-2/3/4/5/6 纯函数面随 p4 落卷；
// EX-P2C-1/7/8/9 落同名行为 check（两步链编排、预热 cookie 会话级恰 1 次、会话级 uuid 并发一致、
// endpoint 脏值出站不消费）；「qq 败 → sogou 接管」组语义面落 tdd-message-translate W2c-2 stub
// 组（本轮零变化）。
//
// W2d 点终态申报（ex 正文同；round-002 C-1 收口）：EX-P2D-2/3/4/5/6/7/12/13 纯函数与结构面随
// p5 落卷；EX-P2D-1/8/9/10/11 落同名行为 check（五步全链编排、密钥三件套会话缓存恰 1 次、整链
// 重取恰一次双形态、整链重取并发单飞、冷链超时降级）+ EX-P2D-12b（三 kind void ctx + 代码面
// ctx.entry.endpoint 唯一消费点=bing 结构钉）。EX-P2D-1/8 两处 P2-3 修订申报（03 评审 P2-3 裁决
// 「js 抓取仅重取链路走、happy path 零 js 下载」）：EX-P2D-1 五步链以重取链触发形态落卷（happy
// path 无 js 步骤——五步链唯一真实形态即重取链）；EX-P2D-8 断言 js GET 恰 0 次（清单原文「js GET
// 恰 1 次」为 P2-3 前契约形态，按修订后契约转写）。
// EX-P2D-3 向量申报（01 清单 §11.3-1）：实证配方 = md5 摘要 16 字节整体解释（mt-probe
// sogou-youdao-iciba-test.ts `md5buf(aesKey).subarray(0,16)` 同形 + translators-server.py
// YoudaoV2 decrypt_result `digest()[:16]` 只读互证），故解密定量向量采用清单备选向量
// rYFOyQj…（清单主向量 HqG14u… 为 hex 串前 16 字符解释，与实证不符不采用）。
// default key 内建实值申报（01 清单 §11.3-3 同族）：2026-11-22 真网实测 keyid 字面
// webfanyi-key-getter-2025 作 sign key → key 接口 500 {"code":1,"msg":"request error"}；页面 js
// 形态 `="webfanyi-key-getter-2025",a="yU5nT5dK3eZ1pI4j";` 的 group(2)=yU5nT5dK3eZ1pI4j 才是
// sign key（实测 200 出密钥出译文）。清单 EX-P2D-2① 向量按「拼接模板 + key=webfanyi-key-getter-2025
// 输入」原样保留为纯函数钉（不触网可复算）；内建常量实值钉另落 EX-P2D-2d（'yU5nT5dK3eZ1pI4j'
// 结构面）。decodeKey/decodeIv 兜底常量 = 页面 js `decodeKey:"…",` 形态实值（真网实测，与 key
// 接口响应 aesKey/aesIv 同值）。
//
// RED 留证：对修复前工作树首跑 → parseBingSessionHtml 未导出（EX-P1-12 起 TypeError）、
// UA Chrome/126 残留 / cache.iid += 1 在位 / tryFetchingGenderDebiasedTranslations 缺失 →
// 结构钉全红，exit ≠ 0。W2d 点（p5）：对 V1 工作树首跑 → youdao 纯函数九件全未导出（EX-P2D-2 起
// TypeError 红）、内建常量实值字面缺位（EX-P2D-2d 红）、V1 残留字面全命中（EX-P2D-13 红）、
// makeYoudaoWeb 无 void ctx 且消费 ctx.entry.endpoint（EX-P2D-12 红）→ exit ≠ 0。
// W5 点（p6）：对未删除工作树首跑 → 六源码 tencent/custom-template 链字面全命中（EX-P6-1/3/4 红）、
// store stub 凭据键读后仍在 + 清键行缺位（EX-P6-2 双红）→ exit ≠ 0。
// W4 点（p7，出卷清单 §7）：baidu-web 死引擎清理 + google-gtx 用户裁决剔除（「谷歌先剔除掉」）+
// 种子终态五序重排 + 配置迁移（sanitize 三规则）。EX-P7 组落本卷（EX-P7-1 结构钉 / EX-P7-2 两
// seed id sanitize 消失行为钉 + 存量归一恰五引擎 / EX-P7-3 出厂五元终序钉）；sanitize 迁移用例
// 细面（T-迁-1/2/3/4/6）落 core 卷；对未清理工作树首跑 → EX-P7-1（kind 引号字面/适配器/端点
// 常量全命中）、EX-P7-2（两 seed id 不消失）、EX-P7-3（七条旧序）全红，exit ≠ 0。
// P8 点（p8，出卷清单 §8）：P1-B 代理面回撤 + UX 修订（P2-1 计数式文案 / P2-2 apply 复用）。
// EX-P8 组落本卷（EX-P8-1 结构钉 / EX-P8-2 存量 proxyUrl 在场直连行为钉 / EX-P8-3 休眠机械活体
// 行为钉 / EX-P8-4 代理输入不存在钉 / RB-MT-T36 apply 复用 / RB-MT-T37 复用窗口边界）；
// P2-1 计数式文案断言落 message 卷（T7-1 5/5 + T7-1b 3/3）；proxyUrl sanitize 剥离落 core 卷
// （T-净-5/6 翻转面）；E4 p1 修复卷 T6/T7/T8/T10 翻转随动。对未回撤工作树首跑 → EX-P8-1
// （types proxyUrl 字段在位）、EX-P8-2（哨兵捕获 CONNECT）、EX-P8-4（trProxyUrl 在位）、
// RB-MT-T36/T37（apply 全量重探）全红，exit ≠ 0；EX-P8-3 为休眠机械保留行为钉（env 链现存活，
// 无红向）。
// round-002 C-1（loopback 行为组收口）：34 条新 check 中 32 条首跑即绿（钉「已实现但无钉」行为，
// 红向 = 实现缺行为或夹具缺陷——夹具缺陷三处修复：并发脚本 post 计数起点、跨 realm 数组
// deepEqual→join 字面比对（卷头注陷阱先例）、\b''\b 正则字界失效）；实现缺行为红核验 2 处：
// EX-P1-10（bing 重抓无单飞：页面 GET 实得 3）、EX-P2A-7（alibaba csrf 重取无单飞：GET 实得 3）
// → 修 translation-engines.ts 补 bingTokenFetch/alibabaCsrfFetch in-flight 单飞（qq/sogou/youdao
// 同形）后全绿。
// 运行：npx tsx scripts/tdd-engine-expansion-verify.ts（登记 scripts/selftest-static-list.txt 尾部）

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as path from 'node:path';
import * as tls from 'node:tls';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import * as translationCore from '../src/shared/translation-core';

const repoRoot = path.resolve(__dirname, '..');
const enginesSrc = fs.readFileSync(path.join(repoRoot, 'src/main/modules/translation-engines.ts'), 'utf8');
// EX-P6 钉面六源码（清单 §6：engines/service/core/config-manager/types/ConfigPage 全源码字面零命中）
const serviceSrc = fs.readFileSync(path.join(repoRoot, 'src/main/modules/translation-service.ts'), 'utf8');
const coreSrc = fs.readFileSync(path.join(repoRoot, 'src/shared/translation-core.ts'), 'utf8');
const configManagerSrc = fs.readFileSync(path.join(repoRoot, 'src/main/modules/config-manager.ts'), 'utf8');
const configTypesSrc = fs.readFileSync(path.join(repoRoot, 'src/shared/types/config.ts'), 'utf8');
const configPageSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/pages/ConfigPage.vue'), 'utf8');

let pass = 0;
let fail = 0;
async function runCheck(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 300)}`);
  }
}

// ── vm 整模块装载（沿 tdd-message-translate-verify 手法；仅 engines 模块，纯函数面零触网） ──

function transpile(src: string): string {
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
}

function runInVm(js: string, extraGlobals: Record<string, unknown>, requireShim: (spec: string) => unknown): Record<string, unknown> {
  const moduleObj: { exports: unknown } = { exports: {} };
  const factory = vm.runInNewContext(
    `(function(require, exports, module, __filename, __dirname){ ${js}\n})`,
    vm.createContext({
      // 跨 realm 一致面与既有卷同口径：内建走 vm 内建；Buffer/URL 等供 shared 纯函数复用。
      setTimeout,
      clearTimeout,
      Buffer,
      console,
      URL,
      URLSearchParams,
      AbortController,
      ...extraGlobals,
    }),
  ) as (r: unknown, e: unknown, m: { exports: unknown }, f: string, d: string) => void;
  factory(requireShim, moduleObj.exports, moduleObj, 'm.ts', path.join(repoRoot, 'src/main/modules'));
  return moduleObj.exports as Record<string, unknown>;
}

/** 装载一份全新 translation-engines（stub 依赖 + 真实 shared；纯函数面不触网不建组）。 */
function loadEngines(): Record<string, unknown> {
  const enginesRequire = (spec: string): unknown => {
    switch (spec) {
      case 'node:crypto':
        return require('node:crypto');
      case 'node:https':
        return require('node:https');
      case 'node:http':
        return require('node:http');
      case 'node:tls':
        return require('node:tls');
      case 'electron':
        // 纯函数面不消费 electron；占位对象防误消费（真消费路径属行为组，届时按既有卷 fake 形态扩）。
        return {};
      case '../utils/logger':
        return { logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } };
      case '../../shared/translation-core':
        return translationCore;
      default:
        throw new Error(`E1 卷 engines require 垫片未映射的模块：${spec}（隔离哨兵：出现未映射 import 即装载失败）`);
    }
  };
  return runInVm(transpile(enginesSrc), { process: { env: {} } }, enginesRequire);
}

// ── EX-P6-2 · config-manager vm 装载（真实 getConfig 读路径 + stub store；store 数据卷侧持有） ──

/** 装载一份全新 config-manager（依赖 stub + sanitizeTranslationConfig 走真实 shared；
 *  createSafeStore 垫片换卷侧 stub store——读路径 delete 行为可直接观测；
 *  deleteCalls 记录 stub store 收到的逐次 delete 键名（round-002 B-1 行为钉面）。 */
function loadConfigManagerWithStore(seed: Record<string, unknown>): {
  mod: Record<string, unknown>;
  data: Record<string, unknown>;
  deleteCalls: string[];
} {
  const data: Record<string, unknown> = { ...seed };
  const deleteCalls: string[] = [];
  const storeInstance = {
    store: data,
    set(patch: Record<string, unknown>): void {
      Object.assign(data, patch);
    },
    has(key: string): boolean {
      return key in data;
    },
    delete(key: string): void {
      deleteCalls.push(key);
      delete data[key];
    },
    clear(): void {
      for (const k of Object.keys(data)) delete data[k];
    },
  };
  const noop = (): void => {};
  const cmRequire = (spec: string): unknown => {
    switch (spec) {
      case 'electron-store':
        return { default: function electronStoreStub(): void {} };
      case 'electron':
        return {
          safeStorage: {
            isEncryptionAvailable: () => true,
            encryptString: (plain: string) => Buffer.from(plain, 'utf8'),
            decryptString: (buf: Buffer) => buf.toString('utf8'),
          },
        };
      case 'node:crypto':
        return require('node:crypto');
      case 'path':
        return require('path');
      case '../utils/logger':
        return { logger: { warn: noop, error: noop, info: noop, debug: noop } };
      case '../utils/safe-store':
        return { createSafeStore: () => storeInstance };
      case '../../shared/translation-core':
        return translationCore;
      // getConfig 读路径触达的 sanitize 族（EX-P6-2 断言不依赖其行为——占位直通）
      case '../../shared/types/thinking':
        return { isValidThinkingLevel: (v: unknown) => typeof v === 'string' && v !== 'auto' };
      case '../../shared/permission-resolver':
        return { isValidPermissionMode: () => true };
      case '../../shared/constants':
        return { DEFAULT_THEME_PALETTE_ID: 'e1-stub', DEFAULT_FONT_SCALE: 'medium' };
      case '../../shared/queue-config':
        return { sanitizeTaskDelayMinutes: () => 5, DEFAULT_TASK_DELAY_MINUTES: 5 };
      case '../../shared/max-turns':
        return { sanitizeMaxTurns: () => 200 };
      case './sdk-skill-overrides':
        return { sanitizeSkillOverridesConfig: () => ({}) };
      case './mcp/mcp-config':
        return {
          sanitizeMcpServersConfig: () => [],
          sanitizeMcpOverridesConfig: () => ({}),
          maskMcpServersForRenderer: (v: unknown) => v,
        };
      case '../../shared/web-access-protocol':
        return { sanitizeWebAccessConfig: (v: unknown) => v, WEB_ACCESS_DEFAULT_PORT: 17654 };
      case '../../shared/provider-library':
        return {
          buildLegacyProviderProfile: () => null,
          maskApiKey: (v: unknown) => v,
          sanitizeProviderModels: () => [],
          migrateLegacyContextWindowOverrides: () => ({ advancedJson: '', profiles: [], migrated: [], dropped: [] }),
        };
      case '../../shared/model-context-windows':
        return { CONTEXT_WINDOW_MAX: 2_000_000, CONTEXT_WINDOW_MIN: 1_000 };
      case './model-resolver':
        return { clearProviderModelsCache: noop };
      case './cli-detector':
        return { resetCliDetectionCache: noop };
      case './settings-projection-merge':
        return { clearProjectionSnapshot: noop };
      case './settings-writer':
        return { writeClaudeSettings: () => ({ ok: true }), SKIP_NO_WORKDIR: 'SKIP_NO_WORKDIR' };
      default:
        throw new Error(`E1 卷 config-manager require 垫片未映射的模块：${spec}（隔离哨兵：出现未映射 import 即装载失败）`);
    }
  };
  const cmSrc = fs.readFileSync(path.join(repoRoot, 'src/main/modules/config-manager.ts'), 'utf8');
  const mod = runInVm(transpile(cmSrc), { process: { env: {} } }, cmRequire);
  return { mod, data, deleteCalls };
}

// ── 会话解析产物形态（parseBingSessionHtml 契约视图） ──

interface BingSessionPartsLike {
  /** 页面 IG（ttranslatev3 URL 查询参数）。 */
  ig: string;
  /** 页面 DOM data-iid 剥 translator. 前缀后的数字（URL 模板 IID=translator.${iid} 拼前缀恰一次）。 */
  iid: number;
  /** params_AbusePreventionHelper 数组[0]（时间戳位，String 化）或对象形态 key。 */
  key: string;
  /** params_AbusePreventionHelper 数组[1] 或对象形态 token。 */
  token: string;
}
type ParseBingSessionHtml = (html: string) => BingSessionPartsLike | null;

// ── alibaba 纯函数契约形态（parseAlibabaCsrfResponse / alibabaTranslateFields /
//    buildMultipartBody / extractAlibabaTranslateText；W2a 点新增） ──

interface AlibabaCsrfLike {
  /** csrf 响应给的请求头名（翻译 POST 以响应给的 headerName 携带 token——硬编码即漂移回归）。 */
  headerName: string;
  /** csrf token（multipart _csrf 字段 + headerName 头双面携带）。 */
  token: string;
}
type ParseAlibabaCsrfResponse = (body: string) => AlibabaCsrfLike | null;
/** csrf 请求装配：五字段固定序（query/srcLang=en/tgtLang=zh/_csrf/domain=general）。 */
type AlibabaTranslateFields = (segment: string, csrfToken: string) => Array<[string, string]>;
/** multipart body 组装：boundary 参数注入（隔离可测）；帧结构 = 每字段一个 part + 终止符。 */
type BuildMultipartBody = (fields: Array<[string, string]>, boundary: string) => string;
/** translateText 提取：success:false / data 缺失 / translateText 缺失或空或非字符串 → null。 */
type ExtractAlibabaTranslateText = (parsed: unknown) => string | null;

// ── qq-transmart 纯函数契约形态（buildQqClientKey / qqSplitPayload / parseQqSentenceList /
//    qqAutoTranslationPayload / extractQqTranslation；W2b 点新增） ──

/** client_key 装配：browser-firefox-110.0.0-Windows 10-{uuid}-{ts} 字面模板（uuid 每会话一个、ts=毫秒时间戳）。 */
type BuildQqClientKey = (uuid: string, tsMs: number) => string;
/** text_analysis 分句请求装配：header.fn=text_analysis + client_key 透传 + merge_broken_line=false。 */
interface QqSplitPayloadLike {
  header: { fn: string; client_key: string };
  type: string;
  text: string;
  normalize: { merge_broken_line: string };
}
type QqSplitPayloadFn = (segment: string, clientKey: string) => QqSplitPayloadLike;
/** 分句解析：sentence_list start/len 切原 text → 分句数组；缺失/空/要素残缺 → null（调用方整段单句兜底）。 */
type ParseQqSentenceList = (parsed: unknown) => string[] | null;
/** auto_translation 请求装配：text_list=['']+分句+[''] 首尾空串、source.lang=en、target.lang=zh。 */
interface QqAutoTranslationPayloadLike {
  header: { fn: string; client_key: string };
  type: string;
  model_category: string;
  source: { lang: string; text_list: string[] };
  target: { lang: string };
}
type QqAutoTranslationPayloadFn = (sentences: string[], clientKey: string) => QqAutoTranslationPayloadLike;
/** 译文提取：ret_code≠succ / auto_translation 缺失或非数组或非字符串元素 → null；去首尾空串拼接。 */
type ExtractQqTranslation = (parsed: unknown) => string | null;

// ── sogou-web 纯函数契约形态（sogouSign / sogouTranslateForm / extractSogouTranslation；W2c 点新增） ──

/** sign 装配：md5(from + to + text + secretCode) 拼接序字面（secretCode 参数注入 → 固定向量可复算）。 */
type SogouSign = (from: string, to: string, text: string, secretCode: string) => string;
/** result POST form 装配：8 字段固定序 from/to/text/uuid/s/client/fr/needQc（Array<[k,v]> 形态）。 */
type SogouTranslateForm = (text: string, sign: string, uuid: string) => Array<[string, string]>;
/** 译文提取：status≠0 / errorCode≠0（键在场才判）/ data.translate.dit 缺失或空或非字符串 → null。 */
type ExtractSogouTranslation = (parsed: unknown) => string | null;

// ── youdao-web V2 纯函数契约形态（youdaoSign / youdaoKeyQuery / youdaoTranslateForm /
//    parseYoudaoKeyResponse / extractYoudaoDefaultKey / extractYoudaoDecodeParts /
//    youdaoAesSecretBytes / youdaoDecrypt / extractYoudaoTranslation；W2d 点新增） ──

/** sign 装配：md5(client=fanyideskweb&mysticTime={T}&product=webfanyi&key={key}) 拼接模板字面。 */
type YoudaoSign = (mysticTime: string, key: string) => string;
/** key 接口查询装配：15 字段固定序（keyid/mysticTime/sign/client/product/appVersion/vendor/
 *  keyfrom/pointParam/yduuid/mid/screen/model/network/abtest）。 */
type YoudaoKeyQuery = (mysticTime: string, key: string) => Array<[string, string]>;
/** 翻译 POST form 装配：20 字段固定序（i/from/to/dictResult/useTerm 五翻译字段 + keyid=webfanyi
 *  载荷 15 字段）。 */
type YoudaoTranslateForm = (segment: string, mysticTime: string, secretKey: string) => Array<[string, string]>;
/** key 响应解析：data.secretKey 非空字符串必需（缺失/空/非字符串 → null）；aesKey/aesIv 缺省 → ''。 */
interface YoudaoKeyParts {
  secretKey: string;
  aesKey: string;
  aesIv: string;
}
type ParseYoudaoKeyResponse = (body: string) => YoudaoKeyParts | null;
/** app js default_key 提取：="webfanyi-key-getter-2025",<var>="<value>"; 形态取值；无形态 → null。 */
type ExtractYoudaoDefaultKey = (js: string) => string | null;
/** app js decodeKey/decodeIv 提取（重取链路兜底值源）：decodeKey:"…", 形态；无形态 → null。 */
interface YoudaoDecodeParts {
  decodeKey: string | null;
  decodeIv: string | null;
}
type ExtractYoudaoDecodeParts = (js: string) => YoudaoDecodeParts;
/** AES 密钥派生定量面：md5(input) 摘要前 16 字节（16 字节摘要整体——实证配方）以字节数组出
 *  （plain array 跨 realm 安全，沿 alibaba/qq 组 JSON.stringify 比对先例）。 */
type YoudaoAesSecretBytes = (input: string) => number[];
/** base64url 密文解密：AES-128-CBC（key/iv = md5 派生）→ utf8 明文；任何失败 → null（不挂起）。 */
type YoudaoDecrypt = (cipher: string, aesKey: string, aesIv: string) => string | null;
/** 译文提取：translateResult[[{tgt}]] 展平拼接（P2-6）；缺失/残缺/空拼接 → null。 */
type ExtractYoudaoTranslation = (parsed: unknown) => string | null;

// ── 页面 fixture（双形态 + 缺失形态；数组形态先例 = p1 卷 makeBingHandler，时间戳位取
//    09 §3 实测数字形态，另附字符串时间戳容忍面） ──

/** 现行数组形态页面（09 §3 实测：[时间戳ms, token, 有效期ms, …]；data-iid 带 translator. 前缀）。 */
const ARRAY_PAGE = [
  '<!DOCTYPE html><html><head><script>',
  'var IG="IG-E1-ARRAY";',
  'var params_AbusePreventionHelper = [1795334774715,"tok-e1-arr","key-e1-legacy",0,1];',
  '</script></head><body>',
  '<div id="tta_outGDCont" data-iid="translator.504633"></div>',
  '</body></html>',
].join('\n');

/** 字符串时间戳数组形态页面（String(arr[0]) 双形态容忍面）。 */
const ARRAY_STR_PAGE = ARRAY_PAGE
  .replace('1795334774715', '"4999999999999"')
  .replace('tok-e1-arr', 'tok-e1-str')
  .replace('IG-E1-ARRAY', 'IG-E1-STR');

/** 旧对象形态页面（防御旧页面回滚；data-iid 用 09 实测值 translator.5026）。 */
const OBJECT_PAGE = [
  '<!DOCTYPE html><html><head><script>',
  'var IG="IG-E1-OBJ";',
  'var params_AbusePrevention = {"key":"key-e1-obj","token":"tok-e1-obj"};',
  '</script></head><body>',
  '<div id="tta_outGDCont" data-iid="translator.5026"></div>',
  '</body></html>',
].join('\n');

/** 双形态皆缺失页面（EX-P1-3 主面：无 params_AbusePrevention 且无 data-iid）。 */
const BARE_PAGE = [
  '<!DOCTYPE html><html><head><script>',
  'var IG="IG-E1-BARE";',
  '</script></head><body><p>no abuse prevention here</p></body></html>',
].join('\n');

/** params 在场但 data-iid 缺失页面（EX-P1-3 子面：IID 要素缺失同样不静默）。 */
const PARAMS_ONLY_PAGE = ARRAY_PAGE.replace('<div id="tta_outGDCont" data-iid="translator.504633"></div>', '');

/** 数组残缺页面（EX-P1-3 子面：JSON 不可解析且无对象形态；data-iid 在场隔离 params 失败面）。 */
const MALFORMED_PAGE = [
  '<!DOCTYPE html><html><head><script>',
  'var IG="IG-E1-MALFORMED";',
  'var params_AbusePreventionHelper = [1795334774715,"tok-e1-x"',
  '</script></head><body>',
  '<div id="tta_outGDCont" data-iid="translator.504633"></div>',
  '</body></html>',
].join('\n');

/** 纯数字 data-iid 页面（EX-P1-5：不二次剥、不误伤）。 */
const NUM_IID_PAGE = ARRAY_PAGE.replace('data-iid="translator.504633"', 'data-iid="504633"')
  .replace('IG-E1-ARRAY', 'IG-E1-NUMIID');

// ── youdao V2 fixture（真网实测形态 2026-11-22：页面 js `="webfanyi-key-getter-2025",a="yU5nT5dK3eZ1pI4j";`
//    decodeKey/decodeIv = ydsecret:// 实值；W2d 点新增） ──

/** 真网页面 js 形态片段（mt-probe 侦察实测：fetchTextTranslateSecretKey 内 const o="keyid",a="value";）。 */
const YOUDAO_JS_REAL = 'fetchTextTranslateSecretKey:async({commit:e},t)=>{const o="webfanyi-key-getter-2025",a="yU5nT5dK3eZ1pI4j";return new Promise((t=>{}))}';

/** 出卷抽象形态（01 清单 EX-P2D-4 钉面：任意变量名/任意值容面 k="v"）。 */
const YOUDAO_JS_ABSTRACT = 'var cfg={secret:"x"};const o="webfanyi-key-getter-2025",k="v";window.init(cfg);';

/** 无 default_key 形态 js（EX-P2D-4 兜底面：js 内无该形态 → 调用方内建常量兜底）。 */
const YOUDAO_JS_BARE = 'var bundle=(function(){return{version:"1.1.4"}}());';

/** 真网 decodeKey/decodeIv 形态片段（2026-11-22 实测实值；`decodeKey:"…",` 双逗号形态）。 */
const YOUDAO_JS_DECODE = 'var a=1,decodeKey:"ydsecret://query/key/B*RGygVywfNBwpmBaZg*WT7SIOUP2T0C9WHMZN39j^DAdaZhAnxvGcCY6VYFwnHl",decodeIv:"ydsecret://query/iv/C@lZe2YzHtZ2CYgaXKSVfsb7Y4QWHjITPPZ0nQp87fBeJ!Iv6v^6fvi2WN@bYpJ4",b=2;';

/** EX-P2D-3b 解密定量向量（01 清单备选向量，出卷侧独立预计算留痕；实证 = md5 摘要 16 字节整体派生）。 */
const YOUDAO_CIPHER_VECTOR = 'rYFOyQjY36mtMJHNOlcuWL32xD-OzwB6drDmD5ezLoQnP5zAiEG6zS3D5Cu8wwhG8DBzDf9xpGxlqm7Gxunvvg';
const YOUDAO_PLAIN_VECTOR = '{"translateResult":[[{"tgt":"你好，世界。"}]]}';
/** md5("test-aes-key") 摘要 16 字节（hex 5b817042225ece29a80f86162a7c91fa 的逐字节展开，出卷留痕）。 */
const YOUDAO_AES_KEY_BYTES = [91, 129, 112, 66, 34, 94, 206, 41, 168, 15, 134, 22, 42, 124, 145, 250];
/** md5("test-aes-iv") 摘要 16 字节（hex c1e80da9d99b0221ce30edc7e0e64c1d 的逐字节展开，出卷留痕）。 */
const YOUDAO_AES_IV_BYTES = [193, 232, 13, 169, 217, 155, 2, 33, 206, 48, 237, 199, 224, 230, 76, 29];

// ── EX-P8 行为面夹具（2026-11-22 扩容批次 p8；loopback TLS + CONNECT 哨兵，零外网出站）──
// 手法沿 tdd-translate-p1-fix-verify（P1 修复卷）：自签证书内嵌 PEM（测试专用非敏感）、TLS 信任
// 经 require 垫片对 node:tls.connect / node:https.request（环回 hostname）注入 ca、http.Server
// 经 emit('connection', tlsSocket) 承载解密流。EX-P8-2/3 仅驱动 engines 模块
// createWebMtEngineGroup（buildEngine translate 闭包即回撤面本体），不涉 service。

const E1_TEST_CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIIDJTCCAg2gAwIBAgIUJwWkvz0YNRjKtYy6fVNEeH/UuAIwDQYJKoZIhvcNAQEL',
  'BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTEyMTE1NTgxOFoXDTM2MTEx',
  'ODE1NTgxOFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF',
  'AAOCAQ8AMIIBCgKCAQEA4wMu744DdWvaNjpIic7upRdd1NCLzo4Anf6St/4HJCn0',
  '0GymXIBoW5WSaxVhjjwIkhdJ43EKHtijWOLVMAaDw05Lna8X0xJRzdqEoJfP68R/',
  'bj41fV8dj9KpuiBXJmzkPXSyTN3u19hlzHc1Fch6VihMyT39WZVek/WmmpwVyqHj',
  '6WXVbFwMz8NL40jyHcdFnPZJOSozJ+AIWaUWxdtXvjNiYhMwRA2H8lE2sZJu+ToB',
  '2lqezkznE81p90o5WTwe2RVqdhCWjHEZ8UKqObw411RUX0hSFcMW3O9ZdlvglDk9',
  '2CWyYQ/xUWE5deoKHOKfmRlmCkELZUAyr8ufnO42mwIDAQABo28wbTAdBgNVHQ4E',
  'FgQUo1/snl6nwGOZfBGtvv+1ZJKVaHgwHwYDVR0jBBgwFoAUo1/snl6nwGOZfBGt',
  'vv+1ZJKVaHgwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARhwR/AAABgglsb2Nh',
  'bGhvc3QwDQYJKoZIhvcNAQELBQADggEBAFi66p8KPIocmlklqk8J/5pa71DW1ycZ',
  'E3ExBM6dKBj/Qr4SWpq9VqR/ypjdJeWCvAsvZmsm83CHmYsKKJx0M7XyjNGvLCOg',
  '35Rz72Cw4iyn/TiRmQLgf3mZ7yTdOJ5xMGSH1Dr9o/NK6pcIrtkbaVGaT9etB/qq',
  'iHG9hlHN/8oF/nGsxtFv23MSRKo1ApcC3FWhtQvSbs8FRuRwCft8XJZcJN8NfnNt',
  'mkFcOV2J0BJl8CAPxG6omEMjkRS8o+1ZzhUx8ALT3yd1D9LU/dj8yGLmrB+Olgt4',
  'sxhPUeH9RJQnsje3/ChSgyd9AoXHuL7r67iDaDDbBwk/KFYDPId5BK8=',
  '-----END CERTIFICATE-----',
].join('\n');

const E1_TEST_KEY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDjAy7vjgN1a9o2',
  'OkiJzu6lF13U0IvOjgCd/pK3/gckKfTQbKZcgGhblZJrFWGOPAiSF0njcQoe2KNY',
  '4tUwBoPDTkudrxfTElHN2oSgl8/rxH9uPjV9Xx2P0qm6IFcmbOQ9dLJM3e7X2GXM',
  'dzUVyHpWKEzJPf1ZlV6T9aaanBXKoePpZdVsXAzPw0vjSPIdx0Wc9kk5KjMn4AhZ',
  'pRbF21e+M2JiEzBEDYfyUTaxkm75OgHaWp7OTOcTzWn3SjlZPB7ZFWp2EJaMcRnx',
  'Qqo5vDjXVFRfSFIVwxbc71l2W+CUOT3YJbJhD/FRYTl16goc4p+ZGWYKQQtlQDKv',
  'y5+c7jabAgMBAAECggEALhQK1mAejpp+N+ybpbFFmmgESTqtbhc/w9IVCNi8rVgA',
  '07+CAxujUxeomSjFXQANg03L1ykuMzWo7lVYjX99BkshqReNv++jgCO/MPOvpf0E',
  'GqXw6IpCb1uEzP1cgzWuHFVQDa8smE5Z12dI9Kt1PYC/mUeGYcUiZekCULam67KP',
  'nWBriBDJ+j9Mx2m+CQ0/96fpYfBQ8OjdjCwC+Hy5XeDrH84P88rQtZ0XP/1ObE3M',
  'rNSjDQkQXoSCMuqpWNw8GaKpeDV1fDyb+XZY5r2Dec80y9NoBLij9z/w+M52Sb+g',
  '2wBbhBgyHalXv9xyOwnVvurMjs9x8fPnEgIh3dYU7QKBgQD8v1y1CvnSeY5emoI+',
  'ViP4dN6svTfzWNCdQdK0AuBGS78hN47BByFQigWvJ0gXwtKDCU5vg5a396eMTT8j',
  'e4h5J0vhjwjsiL2PCphSGFDO+lS+l10zFPL2SEwwgFWGWITEAPQb0g1b8fa5utdD',
  '0vRQk/nFAv7YLYgYPQnW/hSB5QKBgQDl7wp8KGAUzywfPSlmEJuJLpllPG+Dl97n',
  'XRxKo4CqktjEvv6kTEFkf6bvEIAfAb89uDThJ+VpcD+tnyw/jJgeZgQ/a3jT4wDL',
  'qsK9QjusYqNpWEIIQ2pIIVN5T8rFCUHTJt8YohZBxwAWkyqFQJYf+NNQv3AkMwRN',
  'LbG1EZZOfwKBgC2Qtj7xTp6SSYdmpYplbzCwqSBNMJQPc/SV1E2dox8pMrjjUjoc',
  'dfYWG/Y6x7V46wiymdBi0b4yyKLznilgcPcejYCJj9tMv5fVGibauV7HJJYDpcq6',
  'wR6DZDDuQfzpYm4PmfKWCNCFq6xKMdrJYkBQnRvWcWk5tCpifq6iucG9AoGAEwTz',
  '3BNG51G/t5HKk9u50d4d6CbYnoz4bjDgfzgJE5L0BUo7LAH2wsZgW5QE1QvC8usC',
  'zMENE+yqB8WL1nHdv1326fwM0ZIMZcxpMViCMR8znyoixCY3a2H+UqGMB0JdxIaJ',
  'm7MEnkpEsplXwg/2mwxtBlffgc8KgwvNkEm1IicCgYEAwyogRO+redXSGseEXSMT',
  'QHn5UbVv/LWBFjBKVTpz5Nqm50ydnrFmK2SXIGPowql++/q8CfdKpRfl2bLEPhoQ',
  'irYvF2oNPMhQ/a4z6CnxZkbY3+BRgL1Rb00mYZZCeOelDqTpEeJQb9n2pFNxs5Fn',
  'D4lRd8L+B4ltb7l+8NfdVlI=',
  '-----END PRIVATE KEY-----',
].join('\n');

/** node:tls 垫片：环回 TLS 目标注入测试 CA（本组引擎全环回；SNI 空形态不键控恒注入）。 */
const e1TlsShim: typeof tls = (() => {
  const real = require('node:tls') as typeof tls;
  const shim = { ...real } as typeof tls;
  (shim as { connect: unknown }).connect = (...args: unknown[]) => {
    const opts = args[0];
    if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
      (opts as Record<string, unknown>).ca = [E1_TEST_CERT];
    }
    return (real.connect as (...a: unknown[]) => tls.TLSSocket)(...(args as Parameters<typeof real.connect>));
  };
  return shim as unknown as typeof tls;
})();

/** node:https 垫片：环回 hostname 注入测试 CA（其余 1:1；非环回放行原样）。
 *  行为组定向重写（round-002 C-1 扩容；手法 = tdd-translate-p1-fix-verify P1C-T4 httpsShim
 *  出厂域定向重写同形）：alibaba/qq/sogou/youdao 四适配器 URL 恒固定出厂域、不消费 endpoint
 *  （评审 P1-5），e1SetLoopbackRedirect 出厂域 → 环回端口映射在位时把该域请求重写进环回
 *  TLS 端点（零外网出站；重写后 hostname ∈ 环回集 → CA 注入分支照常生效）。hits/seen 记录
 *  重写命中与请求前 hostname（EX-P2x-9「出站恒出厂域」观测面）；映射空 = 行为 1:1（EX-P8 组零影响）。 */
const e1LoopbackRedirectState: { map: Map<string, number>; hits: Map<string, number>; seen: Set<string> } = {
  map: new Map(),
  hits: new Map(),
  seen: new Set(),
};

/** 设置/清空出厂域 → 环回端口定向重写映射（每次设置同时清空 hits/seen；finally 传空复位）。 */
function e1SetLoopbackRedirect(map: Record<string, number>): void {
  e1LoopbackRedirectState.map = new Map(Object.entries(map));
  e1LoopbackRedirectState.hits = new Map();
  e1LoopbackRedirectState.seen = new Set();
}

const e1HttpsShim: typeof https = (() => {
  const real = require('node:https') as typeof https;
  const loopback = new Set(['127.0.0.1', 'localhost', '::1']);
  const shim = { ...real } as typeof https;
  (shim as { request: unknown }).request = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === 'object' && first !== null && !(first instanceof URL)) {
      const opts = first as { hostname?: unknown; port?: unknown; ca?: unknown };
      const host = String(opts.hostname ?? '');
      e1LoopbackRedirectState.seen.add(host);
      const targetPort = e1LoopbackRedirectState.map.get(host);
      if (targetPort !== undefined) {
        opts.hostname = '127.0.0.1';
        opts.port = String(targetPort);
        e1LoopbackRedirectState.hits.set(host, (e1LoopbackRedirectState.hits.get(host) ?? 0) + 1);
      }
      if (loopback.has(String(opts.hostname ?? '')) && opts.ca === undefined) {
        opts.ca = [E1_TEST_CERT];
      }
    }
    return (real.request as (...a: unknown[]) => http.ClientRequest)(...(args as Parameters<typeof real.request>));
  };
  return shim as unknown as typeof https;
})();

/** 装载一份全新 translation-engines（真实传输路径形态：环回 TLS/代理夹具可达；env/electron 注入）。
 *  coreOverrides = shared/translation-core 常量覆写面（EX-P2D-11 冷链挂起用例注入缩短的
 *  TRANSLATION_ENGINE_TRY_TIMEOUT_MS——断言语义「尝试超时内失败终结」不变，仅避免 10s 实钟等待；
 *  默认空 = 真实常量 1:1）。 */
function loadEnginesReal(opts: {
  fakeEnv?: Record<string, string | undefined>;
  electronProxyAnswer?: string;
  coreOverrides?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  const fakeEnv = { ...opts.fakeEnv };
  const fakeElectron = {
    session: { defaultSession: { resolveProxy: async () => opts.electronProxyAnswer ?? 'DIRECT' } },
  };
  const coreModule: unknown = opts.coreOverrides ? { ...translationCore, ...opts.coreOverrides } : translationCore;
  const enginesRequire = (spec: string): unknown => {
    switch (spec) {
      case 'node:crypto':
        return require('node:crypto');
      case 'node:https':
        return e1HttpsShim;
      case 'node:http':
        return require('node:http');
      case 'node:tls':
        return e1TlsShim;
      case 'electron':
        return fakeElectron;
      case '../utils/logger':
        return { logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } };
      case '../../shared/translation-core':
        return coreModule;
      default:
        throw new Error(`E1 行为卷 engines require 垫片未映射的模块：${spec}（隔离哨兵）`);
    }
  };
  return runInVm(
    transpile(enginesSrc),
    { process: { env: fakeEnv, getBuiltinModule: (name: string) => require(name) } },
    enginesRequire,
  );
}

/** loopback CONNECT 哨兵/隧道代理（握手应答 200；record 形态不主动销毁，close 清扫）。 */
async function makeConnectProxy(
  opts: { tlsUpstreamPort?: number } = {},
): Promise<{ port: number; connects: string[]; close(): Promise<void> }> {
  const connects: string[] = [];
  const clientSockets = new Set<net.Socket>();
  const upstreams = new Set<net.Socket>();
  const server = http.createServer(() => {});
  server.on('connect', (req, clientSocket) => {
    connects.push(req.url ?? '');
    clientSockets.add(clientSocket);
    clientSocket.on('close', () => clientSockets.delete(clientSocket));
    clientSocket.on('error', () => {});
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const upstreamPort = opts.tlsUpstreamPort;
    if (upstreamPort) {
      const upstream = net.connect({ port: upstreamPort, host: '127.0.0.1' }, () => {
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
      upstreams.add(upstream);
      upstream.on('close', () => upstreams.delete(upstream));
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('close', () => upstream.destroy());
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    connects,
    close: () => {
      for (const s of upstreams) s.destroy();
      for (const s of clientSockets) s.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

/** loopback TLS 环回端点（自签证书 + http.Server 承载解密流；握手/请求两个观测面）。
 *  captured 记录 path/body/headers 三面（headers = 行为组 UA/Cookie/Content-Type 捕获面，
 *  round-002 C-1 扩容；既有 path/body 消费面不变）。 */
interface TlsLoopbackCapture {
  path: string | undefined;
  body: string;
  headers: http.IncomingHttpHeaders;
}
async function makeTlsLoopbackServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ port: number; handshakes: number; captured: TlsLoopbackCapture[]; close(): Promise<void> }> {
  const captured: TlsLoopbackCapture[] = [];
  let handshakes = 0;
  const httpApp = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c: string) => {
      data += c;
    });
    req.on('end', () => {
      captured.push({ path: req.url, body: data, headers: { ...req.headers } });
      try {
        handler(req, res, data);
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
  });
  const rawSockets = new Set<net.Socket>();
  const server = tls.createServer({ key: E1_TEST_KEY, cert: E1_TEST_CERT }, (socket) => {
    handshakes += 1;
    httpApp.emit('connection', socket);
  });
  server.on('connection', (s) => {
    rawSockets.add(s);
    s.on('close', () => rawSockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    get handshakes() {
      return handshakes;
    },
    captured,
    close: () => {
      for (const s of rawSockets) s.destroy();
      server.closeIdleConnections?.();
      return new Promise((r) => server.close(() => r())).then(() => new Promise<void>((r2) => httpApp.close(() => r2())));
    },
  };
}

/** 假 bing 夹具（/translator 页面会话三件套 + /ttranslatev3 译文；沿 P1 修复卷同款）。 */
function makeBingHandler(text: string): (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void {
  return (req, res) => {
    if (req.url?.startsWith('/translator')) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': ['MUID=test-cookie; Path=/', 'SRCHD=test2; Path=/'] });
      res.end('<html><script>var IG="IG-P1TEST-1234";params_AbusePrevention=["4999999999999","tok-p1-test","key-p1-test",0,1]</script><div id="tta_outGDCont" data-iid="translator.5026"></div>ok</html>');
      return;
    }
    if (req.url?.startsWith('/ttranslatev3')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ translations: [{ text }] }]));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  };
}

async function waitFor(fn: () => boolean, timeoutMs = 5000, label = ''): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时(${timeoutMs}): ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ── 行为组夹具（round-002 C-1 扩容；四协议 loopback script 化 handler + 组驱动小助手） ──
// 每协议一个可变 script 状态对象（测试中途改写应答形态 = 失效/降级/延迟场景脚本化）；
// 应答器返回 {status, body, delayMs?}（delayMs = 并发竞态窗口加宽面，仅并发单飞用例使用），
// 或 Promise<同形>（round-003 flaky 修复：并发单飞用例的失效屏障需挂起应答至两段首 POST 到齐）。

type LoopbackReply = { status: number; body: string; delayMs?: number };
type LoopbackReplyOrPromise = LoopbackReply | Promise<LoopbackReply>;
type E1LoopbackHandler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

function replyJson(res: http.ServerResponse, reply: LoopbackReply): void {
  const send = (): void => {
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(reply.body);
  };
  if (reply.delayMs) setTimeout(send, reply.delayMs);
  else send();
}

/** bing ttranslatev3 失效形态（200 + 空 translations 数组 = 防滥用拦截/token 失效 → 上层重抓一次）。 */
const BING_INVALID_REPLY: LoopbackReply = { status: 200, body: '[]' };
/** youdao 坏密文形态（合法 base64url 全零块 → PKCS7 卸垫失败 → 解密 null → 整链重取）。 */
const YOUDAO_BAD_CIPHER: string = 'A'.repeat(64);

/** multipart body 单字段取值（buildMultipartBody 帧结构：值终止于 \r\n + 下一 --boundary）。 */
function multipartFieldValue(body: string, field: string): string {
  const m = new RegExp(`name="${field}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n(?=--)`).exec(body);
  return m?.[1] ?? '';
}

/** youdao 侧加密（夹具应答用）：AES-128-CBC、key/iv = md5 摘要 16 字节（与适配器派生式同形）。 */
function youdaoEncrypt(plain: string, aesKey: string, aesIv: string): string {
  const c = require('node:crypto') as typeof import('node:crypto');
  const key = c.createHash('md5').update(aesKey, 'utf8').digest().subarray(0, 16);
  const iv = c.createHash('md5').update(aesIv, 'utf8').digest().subarray(0, 16);
  const cipher = c.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]).toString('base64url');
}

/** youdao 重取链路 app js 形态（default key 提取锚点 + decodeKey/decodeIv 形态；值 = 夹具自有字面）。 */
const YOUDAO_JS_REFRESH_FORMS =
  'var m;(function(){const o="webfanyi-key-getter-2025",a="e1JsDefaultKey";})();'
  + 'var b=1,decodeKey:"e1-js-decode-key",decodeIv:"e1-js-decode-iv",c=2;';

/** youdao 页面默认形态（内嵌 app js 地址——YOUDAO_APP_JS_RE 正则目标；shared.ydstatic.com 域
 *  经 httpsShim 定向重写进环回 youdao 端点）。 */
const YOUDAO_PAGE_HTML =
  '<html><head><script src="https://shared.ydstatic.com/dict/translation-website/2.0.42/js/app.e1f4c9.js"></script></head>'
  + '<body><div id="youdao-e1"></div></body></html>';

interface BingLoopState {
  pageStatus: number;
  pageBody: string;
  pageDelayMs: number;
  postResponder: (postIndex: number, form: Record<string, string>) => LoopbackReplyOrPromise;
}

/** bing script 默认态：ARRAY_PAGE 会话页 + ttranslatev3 回显（translations[0].text = form.text）。 */
function bingLoopState(): BingLoopState {
  return {
    pageStatus: 200,
    pageBody: ARRAY_PAGE,
    pageDelayMs: 0,
    postResponder: (_n, form) => ({ status: 200, body: JSON.stringify([{ translations: [{ text: form.text }] }]) }),
  };
}

function makeBingLoopback(st: BingLoopState): E1LoopbackHandler {
  let postIndex = 0;
  return (req, res, body) => {
    if (req.url?.startsWith('/translator')) {
      const send = (): void => {
        res.writeHead(st.pageStatus, { 'Content-Type': 'text/html', 'Set-Cookie': ['MUID=e1-bing; Path=/', 'SRCHD=e1-bing2; Path=/'] });
        res.end(st.pageBody);
      };
      if (st.pageDelayMs) setTimeout(send, st.pageDelayMs);
      else send();
      return;
    }
    if (req.url?.startsWith('/ttranslatev3')) {
      postIndex += 1;
      void Promise.resolve(st.postResponder(postIndex, Object.fromEntries(new URLSearchParams(body)))).then((r) => replyJson(res, r));
      return;
    }
    res.writeHead(404);
    res.end('nf');
  };
}

interface AlibabaLoopState {
  pageDelayMs: number;
  csrfDelayMs: number;
  csrfResponder: (csrfIndex: number) => LoopbackReply;
  translateResponder: (postIndex: number, query: string) => LoopbackReplyOrPromise;
}

/** alibaba script 默认态：预热页 200 → csrf 200 {headerName:'x-csrf-token',token} → translate 回显。 */
function alibabaLoopState(): AlibabaLoopState {
  return {
    pageDelayMs: 0,
    csrfDelayMs: 0,
    csrfResponder: () => ({ status: 200, body: JSON.stringify({ headerName: 'x-csrf-token', token: 'tok-e1-csrf' }) }),
    translateResponder: (_n, query) => ({ status: 200, body: JSON.stringify({ success: true, data: { translateText: query } }) }),
  };
}

function makeAlibabaLoopback(st: AlibabaLoopState): E1LoopbackHandler {
  let csrfIndex = 0;
  let postIndex = 0;
  return (req, res, body) => {
    if (req.url === '/' || req.url === '' || req.url === undefined) {
      const send = (): void => {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'e1alb=warm; Path=/' });
        res.end('<html>warm</html>');
      };
      if (st.pageDelayMs) setTimeout(send, st.pageDelayMs);
      else send();
      return;
    }
    if (req.url?.startsWith('/api/translate/csrftoken')) {
      csrfIndex += 1;
      const send = (): void => replyJson(res, st.csrfResponder(csrfIndex));
      if (st.csrfDelayMs) setTimeout(send, st.csrfDelayMs);
      else send();
      return;
    }
    if (req.url?.startsWith('/api/translate/text')) {
      postIndex += 1;
      void Promise.resolve(st.translateResponder(postIndex, multipartFieldValue(body, 'query'))).then((r) => replyJson(res, r));
      return;
    }
    res.writeHead(404);
    res.end('nf');
  };
}

interface QqLoopState {
  pageStatus: number;
  pageDelayMs: number;
  autoResponder: (postIndex: number, textList: string[]) => LoopbackReply;
}

/** qq script 默认态：预热页 200 → text_analysis 单句切分 → auto_translation 恒等回显
 *  （auto_translation = text_list 原样 → 去首尾空串拼接后译文 = 原段）。 */
function qqLoopState(): QqLoopState {
  return {
    pageStatus: 200,
    pageDelayMs: 0,
    autoResponder: (_n, textList) => ({ status: 200, body: JSON.stringify({ ret_code: 'succ', auto_translation: textList }) }),
  };
}

function makeQqLoopback(st: QqLoopState): E1LoopbackHandler {
  let postIndex = 0;
  return (req, res, body) => {
    if (req.url === '/' || req.url === '' || req.url === undefined) {
      const send = (): void => {
        res.writeHead(st.pageStatus, { 'Content-Type': 'text/html', 'Set-Cookie': 'e1qq=warm; Path=/' });
        res.end('<html>warm</html>');
      };
      if (st.pageDelayMs) setTimeout(send, st.pageDelayMs);
      else send();
      return;
    }
    if (req.url?.startsWith('/api/imt')) {
      postIndex += 1;
      let parsed: { header?: { fn?: unknown }; text?: unknown; source?: { text_list?: unknown } };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        res.writeHead(400);
        res.end('bad json');
        return;
      }
      if (parsed.header?.fn === 'text_analysis') {
        const text = typeof parsed.text === 'string' ? parsed.text : '';
        replyJson(res, { status: 200, body: JSON.stringify({ text, sentence_list: [{ start: 0, len: text.length }] }) });
        return;
      }
      if (parsed.header?.fn === 'auto_translation') {
        const list = Array.isArray(parsed.source?.text_list) ? (parsed.source.text_list as string[]) : [];
        replyJson(res, st.autoResponder(postIndex, list));
        return;
      }
      res.writeHead(400);
      res.end('unknown fn');
      return;
    }
    res.writeHead(404);
    res.end('nf');
  };
}

interface SogouLoopState {
  pageDelayMs: number;
  resultResponder: (postIndex: number, form: Record<string, string>) => LoopbackReply;
}

/** sogou script 默认态：/text 预热 200 → result 回显（data.translate.dit = form.text）。 */
function sogouLoopState(): SogouLoopState {
  return {
    pageDelayMs: 0,
    resultResponder: (_n, form) => ({
      status: 200,
      body: JSON.stringify({ status: 0, errorCode: 0, data: { translate: { dit: form.text } } }),
    }),
  };
}

function makeSogouLoopback(st: SogouLoopState): E1LoopbackHandler {
  let postIndex = 0;
  return (req, res, body) => {
    if (req.url?.startsWith('/text')) {
      const send = (): void => {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'e1sg=warm; Path=/' });
        res.end('<html>warm</html>');
      };
      if (st.pageDelayMs) setTimeout(send, st.pageDelayMs);
      else send();
      return;
    }
    if (req.url?.startsWith('/api/transpc/text/result')) {
      postIndex += 1;
      replyJson(res, st.resultResponder(postIndex, Object.fromEntries(new URLSearchParams(body))));
      return;
    }
    res.writeHead(404);
    res.end('nf');
  };
}

interface YoudaoLoopState {
  pageStatus: number;
  pageBody: string;
  jsStatus: number;
  jsBody: string;
  keyResponder: (keyIndex: number) => LoopbackReply;
  webResponder: (postIndex: number, form: Record<string, string>) => LoopbackReplyOrPromise;
}

/** youdao script 默认态：页面（内嵌 app js 地址）→ js 形态 → key 200 {secretKey,aesKey,aesIv}
 *  → webtranslate 应答 = AES 加密回显（translateResult[[{tgt: form.i}]]，key/iv=md5 派生）。 */
function youdaoLoopState(): YoudaoLoopState {
  return {
    pageStatus: 200,
    pageBody: YOUDAO_PAGE_HTML,
    jsStatus: 200,
    jsBody: YOUDAO_JS_REFRESH_FORMS,
    keyResponder: () => ({
      status: 200,
      body: JSON.stringify({ data: { secretKey: 'e1-secret-key', aesKey: 'e1-aes-key', aesIv: 'e1-aes-iv' } }),
    }),
    webResponder: (_n, form) => ({
      status: 200,
      body: youdaoEncrypt(JSON.stringify({ translateResult: [[{ tgt: form.i }]] }), 'e1-aes-key', 'e1-aes-iv'),
    }),
  };
}

function makeYoudaoLoopback(st: YoudaoLoopState): E1LoopbackHandler {
  let keyIndex = 0;
  let postIndex = 0;
  return (req, res, body) => {
    if (req.url === '/' || req.url === '' || req.url === undefined) {
      res.writeHead(st.pageStatus, { 'Content-Type': 'text/html', 'Set-Cookie': 'e1yd=warm; Path=/' });
      res.end(st.pageBody);
      return;
    }
    if (req.url?.startsWith('/dict/translation-website/')) {
      res.writeHead(st.jsStatus, { 'Content-Type': 'application/javascript' });
      res.end(st.jsBody);
      return;
    }
    if (req.url?.startsWith('/webtranslate/key')) {
      keyIndex += 1;
      replyJson(res, st.keyResponder(keyIndex));
      return;
    }
    if (req.url?.startsWith('/webtranslate')) {
      postIndex += 1;
      void Promise.resolve(st.webResponder(postIndex, Object.fromEntries(new URLSearchParams(body)))).then((r) => replyJson(res, r));
      return;
    }
    res.writeHead(404);
    res.end('nf');
  };
}

/** 组驱动小助手（createWebMtEngineGroup 直组——行为组不走 service 编排，段级面直观测）。 */
interface E1GroupAttempt {
  ok: boolean;
  text?: string;
  error?: string;
  engineId?: string;
  tried: string[];
}
type E1EngineGroup = { translateSegment: (segment: string, signal: AbortSignal, startEngineId?: string) => Promise<E1GroupAttempt> };

function buildE1Group(enginesMod: Record<string, unknown>, engines: Array<Record<string, unknown>>): E1EngineGroup {
  return (
    enginesMod as { createWebMtEngineGroup: (c: unknown, o?: unknown) => E1EngineGroup }
  ).createWebMtEngineGroup({ engines }, {});
}

/** 捕获面计数小助手（按路径前缀计数）。 */
function countCaptured(captured: TlsLoopbackCapture[], pathPrefix: string): number {
  return captured.filter((c) => (c.path ?? '').startsWith(pathPrefix)).length;
}

/** 捕获面精确计数（剥查询串后路径全等——'/' 预热页与 '/webtranslate' POST 等易与前缀混场面）。 */
function countCapturedExact(captured: TlsLoopbackCapture[], path: string): number {
  return captured.filter((c) => (c.path ?? '').split('?')[0] === path).length;
}

function capturedHeader(captured: TlsLoopbackCapture[], pathPrefix: string, header: string): string | undefined {
  return captured.find((c) => (c.path ?? '').startsWith(pathPrefix))?.headers[header] as string | undefined;
}

/** bing ttranslatev3 表单抽取（首条 POST）。 */
function bingPostForms(captured: TlsLoopbackCapture[]): Array<Record<string, string>> {
  return captured
    .filter((c) => (c.path ?? '').startsWith('/ttranslatev3'))
    .map((c) => Object.fromEntries(new URLSearchParams(c.body)));
}

/** probe 行为面 harness（EX-P1-11；真实 engines + loopback 端点配置，零 transport 覆盖）。 */
function loadServiceProbeReal(enginesConfig: Array<Record<string, unknown>>): { mod: Record<string, unknown>; saveCalls: Array<Record<string, unknown>> } {
  const saveCalls: Array<Record<string, unknown>> = [];
  const config: Record<string, unknown> = { translation: { engines: enginesConfig } };
  const configStub = {
    getConfig: (): Record<string, unknown> => config,
    saveConfig: (partial: Record<string, unknown>): Record<string, unknown> => {
      saveCalls.push(partial);
      Object.assign(config, partial);
      return config;
    },
  };
  const enginesMod = loadEnginesReal({ fakeEnv: {}, electronProxyAnswer: 'DIRECT' });
  const serviceRequire = (spec: string): unknown => {
    switch (spec) {
      case 'node:crypto':
        return require('node:crypto');
      case './config-manager':
        return configStub;
      case '../utils/logger':
        return { logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } };
      case './push-bus':
        return { pushToMainWindow: () => {} };
      case './translation-engines':
        return enginesMod;
      case '../../shared/constants':
        return require('../src/shared/constants');
      case '../../shared/translation-core':
        return translationCore;
      default:
        throw new Error(`E1 probe 行为卷 service require 垫片未映射的模块：${spec}（隔离哨兵）`);
    }
  };
  const mod = runInVm(
    transpile(serviceSrc),
    { process: { env: {}, getBuiltinModule: (name: string) => require(name) } },
    serviceRequire,
  );
  return { mod, saveCalls };
}

// ── RB-MT-T36/T37 · probeEngines apply 复用行为面（service vm 装载 + stub transport 计数 + fake clock） ──

interface ProbeHarness {
  mod: Record<string, unknown>;
  saveCalls: Array<Record<string, unknown>>;
  calls: Array<{ engineKind: string; segment: string }>;
  clock: { offsetMs: number; advance: (ms: number) => void };
  setScripted(fn: (kind: string) => string | { ok: true; text: string; delayMs?: number } | { ok: false; error: string; delayMs?: number }): void;
}

/** 装载一份全新 translation-service（探测行为面）。engines 同样 vm 装载（stub 依赖），transport
 *  经 __setTranslationTransportForTest 注入（stub 即刻应答，真实 HTTP 零触达）；fake clock 注入
 *  service realm 的 Date（确定性虚拟钟：now() = virtualNow + offsetMs，virtualNow 仅经脚本延迟与
 *  显式 advance 推进、真实时间不渗入——RB-MT-T37b 恰 <TTL/恰 =TTL 边界差值可字面精确构造，
 *  round-003 flaky 修复：原「真实 + offsetMs」形态把首探完成→复用检查的真实间隙（GC/调度 ≥1ms）
 *  加进差值，TTL-1 边界偶发翻红）。 */
function loadServiceProbe(): ProbeHarness {
  let virtualNow = Date.now();
  const clock = {
    offsetMs: 0,
    advance: (ms: number): void => {
      virtualNow += ms;
    },
  };
  class ProbeDate extends Date {
    static now(): number {
      return virtualNow + clock.offsetMs;
    }
  }
  const saveCalls: Array<Record<string, unknown>> = [];
  const config: Record<string, unknown> = {
    translation: {
      engines: [
        { id: 'bing-web', kind: 'bing-web', enabled: true, order: 0 },
        { id: 'alibaba-web', kind: 'alibaba-web', enabled: true, order: 1 },
        { id: 'qq-transmart', kind: 'qq-transmart', enabled: true, order: 2 },
        { id: 'sogou-web', kind: 'sogou-web', enabled: true, order: 3 },
        { id: 'youdao-web', kind: 'youdao-web', enabled: true, order: 4 },
      ],
    },
  };
  const configStub = {
    getConfig: (): Record<string, unknown> => config,
    saveConfig: (partial: Record<string, unknown>): Record<string, unknown> => {
      saveCalls.push(partial);
      Object.assign(config, partial);
      return config;
    },
  };
  const loggerStub = { logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } };
  const pushStub = { pushToMainWindow: () => {} };
  const calls: Array<{ engineKind: string; segment: string }> = [];
  // scripted 应答形态：string = 即刻成功；对象 = 显式 ok/error + 可选 delayMs（延迟差分用于
  // latency 升序断言确定性——stub 即刻应答的 latency ≈0 并发抖动会破坏稳定排序前提）。
  let scripted: (kind: string) => string | { ok: true; text: string; delayMs?: number } | { ok: false; error: string; delayMs?: number } = (kind) => `探@${kind}`;
  const transport = (req: { engineKind: string; segment: string }): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
    calls.push({ engineKind: req.engineKind, segment: req.segment });
    const r = scripted(req.engineKind);
    if (typeof r === 'string') return Promise.resolve({ ok: true, text: r });
    const payload = r.ok ? { ok: true as const, text: r.text } : { ok: false as const, error: r.error };
    if (r.delayMs) return new Promise((resolve) => setTimeout(() => { virtualNow += r.delayMs; resolve(payload); }, r.delayMs));
    return Promise.resolve(payload);
  };
  const enginesMod = loadEngines();
  const serviceRequire = (spec: string): unknown => {
    switch (spec) {
      case 'node:crypto':
        return require('node:crypto');
      case './config-manager':
        return configStub;
      case '../utils/logger':
        return loggerStub;
      case './push-bus':
        return pushStub;
      case './translation-engines':
        return enginesMod;
      case '../../shared/constants':
        return require('../src/shared/constants');
      case '../../shared/translation-core':
        return translationCore;
      default:
        throw new Error(`E1 探测卷 service require 垫片未映射的模块：${spec}（隔离哨兵）`);
    }
  };
  const mod = runInVm(
    transpile(serviceSrc),
    {
      process: { env: {}, getBuiltinModule: (name: string) => require(name) },
      Date: ProbeDate,
    },
    serviceRequire,
  );
  (mod as { __setTranslationTransportForTest(t: unknown): void }).__setTranslationTransportForTest(transport);
  return {
    mod,
    saveCalls,
    calls,
    clock,
  setScripted(fn: (kind: string) => string | { ok: true; text: string; delayMs?: number } | { ok: false; error: string; delayMs?: number }): void {
    scripted = fn;
  },
  };
}

async function main(): Promise<void> {
  console.log('=== E1 · bing 会话解析纯函数组（W1 点创建） ===');
  const mod = loadEngines();
  const parse = mod.parseBingSessionHtml as ParseBingSessionHtml | undefined;

  await runCheck('EX-P1-12 parseBingSessionHtml 导出且可独立调用（提纯契约本体；未导出 = 红）', () => {
    assert.equal(typeof parse, 'function', 'parseBingSessionHtml 未导出（页面→会话三件套未提为可测纯函数）');
  });

  await runCheck('EX-P1-1 数组形态：key=arr[0] 时间戳位、token=arr[1]；旧 arr[2] 位不再作 key（09 §2 差异1 根因）', () => {
    const parts = parse!(ARRAY_PAGE);
    assert.ok(parts, '数组形态页面解析产物为 null（应出三件套）');
    assert.equal(parts.key, '1795334774715', `key 应取数组[0] 时间戳位并 String 化，实得：${parts.key}`);
    assert.notEqual(parts.key, 'key-e1-legacy', 'key 取了旧 arr[2] 位（有效期 ms 当 key 发送 = 205 根因回归）');
    assert.equal(parts.token, 'tok-e1-arr', `token 应取数组[1]，实得：${parts.token}`);
    assert.equal(parts.ig, 'IG-E1-ARRAY', `IG 提取不符：${parts.ig}`);
    assert.equal(typeof parts.key, 'string', 'key 应为 string 形态（数字时间戳 String 化）');
    assert.equal(typeof parts.token, 'string', 'token 应为 string 形态');
  });

  await runCheck('EX-P1-1b 字符串时间戳数组形态：String(arr[0]) 双形态容忍（key 仍取 arr[0] 位）', () => {
    const parts = parse!(ARRAY_STR_PAGE);
    assert.ok(parts, '字符串时间戳数组形态解析产物为 null');
    assert.equal(parts.key, '4999999999999', `字符串时间戳位应 String 化为 key，实得：${parts.key}`);
    assert.equal(parts.token, 'tok-e1-str', `token 应取数组[1]，实得：${parts.token}`);
  });

  await runCheck('EX-P1-2 旧对象形态 {key,token} 回落保留（防御旧页面回滚），产物语义与数组形态一致', () => {
    const parts = parse!(OBJECT_PAGE);
    assert.ok(parts, '旧对象形态页面解析产物为 null（对象回落丢失）');
    assert.equal(parts.key, 'key-e1-obj', `对象形态 key 提取不符：${parts.key}`);
    assert.equal(parts.token, 'tok-e1-obj', `对象形态 token 提取不符：${parts.token}`);
    assert.equal(parts.ig, 'IG-E1-OBJ', `对象形态 IG 提取不符：${parts.ig}`);
    assert.equal(parts.iid, 5026, `对象形态 data-iid 提取不符：${String(parts.iid)}`);
  });

  await runCheck('EX-P1-3 双形态皆缺失 / params 在场 data-iid 缺失 / 数组残缺 → null（不静默空值）', () => {
    assert.equal(parse!(BARE_PAGE), null, '双形态皆缺失应返回 null（静默空值 = 畸形请求出站面）');
    assert.equal(parse!(PARAMS_ONLY_PAGE), null, 'params 在场但 data-iid 缺失应返回 null（IID 要素缺失不静默）');
    assert.equal(parse!(MALFORMED_PAGE), null, '数组残缺（JSON 不可解析且无对象形态）应返回 null');
  });

  await runCheck('EX-P1-4 data-iid="translator.504633" → 会话存数字 504633（前缀恰剥一次）+ URL 模板 IID=translator.${} 字面不动', () => {
    const parts = parse!(ARRAY_PAGE);
    assert.ok(parts, '解析产物为 null');
    assert.equal(parts.iid, 504633, `IID 未剥 translator. 前缀或剥错位（双拼面），实得：${String(parts.iid)}`);
    assert.equal(typeof parts.iid, 'number', '会话侧 IID 应存数字形态（URL 模板拼前缀恰一次）');
    // 结构面：URL 模板保持 translator.${…} 单次拼接（模板动过 = 数字语义破坏面）
    assert.ok(enginesSrc.includes('IID=translator.${'), 'URL 模板 IID=translator.${} 字面被改动（EX-P1-4 结构面）');
    assert.ok(!enginesSrc.includes('translator.translator.'), '源码出现 translator.translator. 双拼字面（EX-P1-4 负向面）');
  });

  await runCheck('EX-P1-5 data-iid="504633" 纯数字 → 504633（不二次剥、不误伤）', () => {
    const parts = parse!(NUM_IID_PAGE);
    assert.ok(parts, '纯数字 data-iid 页面解析产物为 null（不应误判失败）');
    assert.equal(parts.iid, 504633, `纯数字 data-iid 被误伤（二次剥/不识别），实得：${String(parts.iid)}`);
  });

  await runCheck('EX-P1-6 ttranslatev3 form 含 tryFetchingGenderDebiasedTranslations:\u0027true\u0027（结构面；捕获面随行为组扩容）', () => {
    assert.ok(
      enginesSrc.includes("tryFetchingGenderDebiasedTranslations: 'true'"),
      'bingOneChunk form 缺 tryFetchingGenderDebiasedTranslations:\u0027true\u0027（09 §2 差异3）',
    );
  });

  await runCheck('EX-P1-7 BROWSER_UA 版本段 Chrome/141.0.0.0、无 Chrome/126 残留（结构面）', () => {
    const m = /const BROWSER_UA = '([^']+)';/.exec(enginesSrc);
    assert.ok(m, 'BROWSER_UA 常量缺失');
    assert.ok(m[1].includes('Chrome/141.0.0.0'), `UA 版本段未升 141：${m[1]}`);
    assert.ok(!m[1].includes('Chrome/126'), `UA 126 残留：${m[1]}`);
  });

  await runCheck('W1-结构钉 cache.iid += 1 自增删除（IID 改用页面值）', () => {
    assert.ok(!/cache\.iid\s*\+=\s*1/.test(enginesSrc), 'cache.iid += 1 自增残留（IID 应改用页面 DOM data-iid 值）');
  });

  // ── E1 · alibaba 纯函数固定向量组（W2a 点扩容；协议事实 = 09 实测配方 + mt-probe Stage A
  //    alibaba-test.ts 只读采纳：csrf 响应顶层 headerName/token → multipart POST →
  //    data.translateText；TS 独立实现，零 GPL 代码拷贝进仓库） ──
  console.log('=== E1 · alibaba csrf/解析纯函数组（W2a 点扩容） ===');
  const parseAlibabaCsrf = mod.parseAlibabaCsrfResponse as ParseAlibabaCsrfResponse | undefined;
  const alibabaFields = mod.alibabaTranslateFields as AlibabaTranslateFields | undefined;
  const buildMultipart = mod.buildMultipartBody as BuildMultipartBody | undefined;
  const extractAlibabaText = mod.extractAlibabaTranslateText as ExtractAlibabaTranslateText | undefined;

  await runCheck('EX-P2A-2a parseAlibabaCsrfResponse 导出且固定响应 → 固定产物 {headerName,token}（headerName 动态透传）', () => {
    assert.equal(typeof parseAlibabaCsrf, 'function', 'parseAlibabaCsrfResponse 未导出（csrf 响应解析未提为可测纯函数）');
    const parts = parseAlibabaCsrf!('{"success":true,"headerName":"x-csrf-token","token":"tok-e1-alibaba"}');
    assert.ok(parts, '固定 csrf 响应解析产物为 null（应出 {headerName,token}）');
    assert.equal(parts.headerName, 'x-csrf-token', `headerName 提取不符：${parts.headerName}`);
    assert.equal(parts.token, 'tok-e1-alibaba', `token 提取不符：${parts.token}`);
    // headerName 动态性：响应给什么就带什么（不硬编码请求头名）
    const alt = parseAlibabaCsrf!('{"headerName":"csrf-token","token":"t2"}');
    assert.ok(alt && alt.headerName === 'csrf-token' && alt.token === 't2', 'headerName 非动态透传（硬编码面）');
  });

  await runCheck('EX-P2A-2b csrf 响应失败形态 → null：非 JSON / headerName 缺失 / token 缺失或非字符串（不静默空值）', () => {
    assert.equal(parseAlibabaCsrf!('not json at all'), null, '非 JSON 响应应返回 null');
    assert.equal(parseAlibabaCsrf!(''), null, '空响应应返回 null');
    assert.equal(parseAlibabaCsrf!('{"token":"tok-only"}'), null, 'headerName 缺失应返回 null');
    assert.equal(parseAlibabaCsrf!('{"headerName":"x-csrf-token"}'), null, 'token 缺失应返回 null');
    assert.equal(parseAlibabaCsrf!('{"headerName":"x-csrf-token","token":123}'), null, 'token 非字符串应返回 null');
    assert.equal(parseAlibabaCsrf!('{"headerName":"x-csrf-token","token":""}'), null, 'token 空串应返回 null（不发畸形请求）');
    assert.equal(parseAlibabaCsrf!('{"headerName":"","token":"t"}'), null, 'headerName 空串应返回 null');
  });

  await runCheck('EX-P2A-2c alibabaTranslateFields csrf 请求装配固定向量：五字段固定序（query/srcLang=en/tgtLang=zh/_csrf/domain=general）', () => {
    assert.equal(typeof alibabaFields, 'function', 'alibabaTranslateFields 未导出（csrf 请求装配未提为可测纯函数）');
    const fields = alibabaFields!('hello world', 'tok-e1-alibaba');
    // vm 侧产物跨 realm 原型 ≠ 宿主（tdd-message-translate 卷头注陷阱先例）——JSON.stringify 字面比对。
    assert.equal(
      JSON.stringify(fields),
      JSON.stringify([
        ['query', 'hello world'],
        ['srcLang', 'en'],
        ['tgtLang', 'zh'],
        ['_csrf', 'tok-e1-alibaba'],
        ['domain', 'general'],
      ]),
      `字段装配固定向量不符：${JSON.stringify(fields)}`,
    );
    // 目标语言字面钉（RB-MT-T11 alibaba 面）：tgtLang 恰为 'zh'（非 zh-CN/zh-Hans 漂移）
    assert.equal(fields[2]?.[1], 'zh', 'tgtLang 字面漂移（契约 = zh）');
  });

  await runCheck('EX-P2A-2d buildMultipartBody 组装：boundary 参数注入精确帧结构 + 五字段在位 + 无占位残留', () => {
    assert.equal(typeof buildMultipart, 'function', 'buildMultipartBody 未导出（multipart 组装未提为可测纯函数）');
    // boundary 隔离可测：固定 boundary → 精确 body（固定向量；帧 = --b\r\n + Disposition 行 +
    // 空行 + 值 + \r\n，终止 = --b--\r\n）
    const fields: Array<[string, string]> = [['query', 'hi'], ['srcLang', 'en']];
    assert.equal(
      buildMultipart!(fields, 'e1fixedboundary'),
      '--e1fixedboundary\r\nContent-Disposition: form-data; name="query"\r\n\r\nhi\r\n'
        + '--e1fixedboundary\r\nContent-Disposition: form-data; name="srcLang"\r\n\r\nen\r\n'
        + '--e1fixedboundary--\r\n',
      'multipart 帧结构固定向量不符（boundary 帧面漂移）',
    );
    // 全五字段装配面：body 含 query=<文本>/srcLang=en/tgtLang=zh/_csrf=<token>/domain=general
    const full = buildMultipart!(alibabaFields!('你好原文', 'tok-e1-alibaba'), 'e1fullboundary');
    for (const [k, v] of [['query', '你好原文'], ['srcLang', 'en'], ['tgtLang', 'zh'], ['_csrf', 'tok-e1-alibaba'], ['domain', 'general']] as Array<[string, string]>) {
      assert.ok(full.includes(`name="${k}"`), `multipart body 缺字段 ${k}`);
      assert.ok(full.includes(`\r\n\r\n${v}\r\n`), `multipart body 字段 ${k} 值不在位：${v}`);
    }
    for (const ph of ['{text}', '{source}', '{target}', '{segment}']) {
      assert.ok(!full.includes(ph), `multipart body 残留占位符字面：${ph}`);
    }
    assert.ok(full.startsWith('--e1fullboundary\r\n') && full.endsWith('--e1fullboundary--\r\n'), 'multipart body 起止帧不符');
  });

  await runCheck('EX-P2A-2e extractAlibabaTranslateText 固定向量：data.translateText → 译文', () => {
    assert.equal(typeof extractAlibabaText, 'function', 'extractAlibabaTranslateText 未导出（translateText 提取未提为可测纯函数）');
    const text = extractAlibabaText!({ success: true, data: { translateText: '你好，世界。' } });
    assert.equal(text, '你好，世界。', `translateText 固定向量提取不符：${text}`);
    // 非 success 键形态容忍（实测响应未必带 success——只钉失败形态判定面）
    const noFlag = extractAlibabaText!({ data: { translateText: '你好' } });
    assert.equal(noFlag, '你好', '无 success 键形态误判失败（提取过严）');
  });

  await runCheck('EX-P2A-2f translateText 失败形态 → null：success:false / data 缺失 / translateText 缺失/空串/非字符串', () => {
    assert.equal(extractAlibabaText!({ success: false, data: { translateText: 'x' } }), null, 'success:false 应返回 null（业务失败冒充成功面）');
    assert.equal(extractAlibabaText!({ success: true }), null, 'data 缺失应返回 null');
    assert.equal(extractAlibabaText!({ success: true, data: {} }), null, 'translateText 缺失应返回 null');
    assert.equal(extractAlibabaText!({ success: true, data: { translateText: '' } }), null, '空译文应返回 null（空译文 ≠ 成功态）');
    assert.equal(extractAlibabaText!({ success: true, data: { translateText: 123 } }), null, 'translateText 非字符串应返回 null');
    assert.equal(extractAlibabaText!('not object'), null, '非对象响应应返回 null');
    assert.equal(extractAlibabaText!(null), null, 'null 响应应返回 null');
  });

  // ── E1 · qq-transmart 纯函数固定向量组（W2b 点扩容；协议事实 = mt-probe transmart-test.ts
  //    实测配方（预热→client_key→text_analysis 分句→auto_translation 出译文）+ translators-server.py
  //    QQTranSmart 节只读采纳：TS 独立实现，零 GPL 代码拷贝进仓库） ──
  console.log('=== E1 · qq-transmart 纯函数组（W2b 点扩容） ===');
  const buildQqKey = mod.buildQqClientKey as BuildQqClientKey | undefined;
  const qqSplit = mod.qqSplitPayload as QqSplitPayloadFn | undefined;
  const qqParseSentences = mod.parseQqSentenceList as ParseQqSentenceList | undefined;
  const qqAutoPayload = mod.qqAutoTranslationPayload as QqAutoTranslationPayloadFn | undefined;
  const qqExtract = mod.extractQqTranslation as ExtractQqTranslation | undefined;

  await runCheck('EX-P2B-2a buildQqClientKey 导出且固定向量：browser-firefox-110.0.0-Windows 10-{uuid}-{ts} 字面模板（uuid/ts 注入 → 固定产物）', () => {
    assert.equal(typeof buildQqKey, 'function', 'buildQqClientKey 未导出（client_key 装配未提为可测纯函数）');
    const key = buildQqKey!('e1-qq-uuid', 1795334774715);
    assert.equal(
      key,
      'browser-firefox-110.0.0-Windows 10-e1-qq-uuid-1795334774715',
      `client_key 固定向量不符（模板字面漂移）：${key}`,
    );
    // ts 形态钉：毫秒时间戳（13 位）直拼模板尾段——秒级/Date 形态均漂移面
    const key2 = buildQqKey!('u2', 1700000000000);
    assert.equal(key2, 'browser-firefox-110.0.0-Windows 10-u2-1700000000000', 'ts 段拼接不符');
    // 结构面：模板字面在源码（防散落拼接漂移）
    assert.ok(
      enginesSrc.includes('browser-firefox-110.0.0-Windows 10-${'),
      'client_key 模板字面不在位（engines 源码结构面）',
    );
  });

  await runCheck('EX-P2B-2b qqSplitPayload 分句请求装配固定向量：fn=text_analysis + client_key 透传 + merge_broken_line=false', () => {
    assert.equal(typeof qqSplit, 'function', 'qqSplitPayload 未导出（分句请求装配未提为可测纯函数）');
    const payload = qqSplit!('hello world', 'ck-e1-qq');
    // vm 侧产物跨 realm 原型 ≠ 宿主（alibaba 组 2c 先例）——JSON.stringify 字面比对。
    assert.equal(
      JSON.stringify(payload),
      JSON.stringify({
        header: { fn: 'text_analysis', client_key: 'ck-e1-qq' },
        type: 'plain',
        text: 'hello world',
        normalize: { merge_broken_line: 'false' },
      }),
      `分句请求装配固定向量不符：${JSON.stringify(payload)}`,
    );
    assert.equal(payload.header.fn, 'text_analysis', 'header.fn 字面漂移（契约 = text_analysis）');
    assert.equal(payload.header.client_key, 'ck-e1-qq', 'client_key 未透传进 header（协议字面钉）');
    assert.equal(payload.normalize.merge_broken_line, 'false', 'merge_broken_line 字面漂移（实测配方 = \u0027false\u0027）');
  });

  await runCheck('EX-P2B-2c parseQqSentenceList start/len 切原 text 固定向量：逐句切片、句间缺口不误并、逐字保全', () => {
    assert.equal(typeof qqParseSentences, 'function', 'parseQqSentenceList 未导出（分句解析未提为可测纯函数）');
    // 实测配方形态：{text, sentence_list:[{start,len}]} → 按条目 [start, start+len) 切片
    const parsed = {
      text: 'Hello world. Second sentence.',
      sentence_list: [
        { start: 0, len: 12 },
        { start: 13, len: 16 },
      ],
    };
    const sentences = qqParseSentences!(parsed);
    // vm 侧产物跨 realm 原型 ≠ 宿主（alibaba 组 2c 先例）——JSON.stringify 字面比对。
    assert.equal(
      JSON.stringify(sentences),
      JSON.stringify(['Hello world.', 'Second sentence.']),
      `start/len 切片固定向量不符：${JSON.stringify(sentences)}`,
    );
  });

  await runCheck('EX-P2B-4 parseQqSentenceList 缺失兜底面：sentence_list 缺失/空数组/要素残缺 → null；组合装配 text_list=[\u0027\u0027, 整段, \u0027\u0027]（整段单句兜底契约钉）', () => {
    assert.equal(qqParseSentences!({ text: 'x' }), null, 'sentence_list 缺失应返回 null（调用方整段单句兜底）');
    assert.equal(qqParseSentences!({ text: 'x', sentence_list: [] }), null, '空 sentence_list 应返回 null（同兜底面）');
    assert.equal(qqParseSentences!({ sentence_list: [{ start: 0, len: 1 }] }), null, 'text 缺失应返回 null');
    assert.equal(qqParseSentences!({ text: 'x', sentence_list: [{ start: 0 }] }), null, 'len 缺失应返回 null');
    assert.equal(qqParseSentences!({ text: 'x', sentence_list: [{ start: '0', len: 1 }] }), null, 'start 非数字应返回 null');
    assert.equal(qqParseSentences!({ text: 'x', sentence_list: [{ start: 0, len: -1 }] }), null, 'len 负值应返回 null（不发畸形切片）');
    assert.equal(qqParseSentences!('not object'), null, '非对象响应应返回 null');
    assert.equal(qqParseSentences!(null), null, 'null 响应应返回 null');
    // 兜底组合面（EX-P2B-4 主体：整段作单句 → auto_translation 照常发出、text_list=['', 整段, '']）
    const fallbackList = qqAutoPayload!(qqParseSentences!({ text: 'x' }) ?? ['整段原文'], 'ck-e1-qq');
    assert.equal(
      JSON.stringify(fallbackList.source.text_list),
      JSON.stringify(['', '整段原文', '']),
      `缺失兜底组合装配不符（整段未作单句）：${JSON.stringify(fallbackList.source.text_list)}`,
    );
  });

  await runCheck('EX-P2B-2d qqAutoTranslationPayload 装配固定向量：text_list=[\u0027\u0027]+分句+[\u0027\u0027] 首尾空串、source.lang=en、target.lang=zh', () => {
    assert.equal(typeof qqAutoPayload, 'function', 'qqAutoTranslationPayload 未导出（text_list 装配未提为可测纯函数）');
    const payload = qqAutoPayload!(['句1', '句2'], 'ck-e1-qq');
    assert.equal(
      JSON.stringify(payload),
      JSON.stringify({
        header: { fn: 'auto_translation', client_key: 'ck-e1-qq' },
        type: 'plain',
        model_category: 'normal',
        source: { lang: 'en', text_list: ['', '句1', '句2', ''] },
        target: { lang: 'zh' },
      }),
      `auto_translation 装配固定向量不符：${JSON.stringify(payload)}`,
    );
    // lang 字面钉（RB-MT-T11 qq 面）：source.lang=en、target.lang=zh（非 zh-CN/zh-Hans 漂移）
    assert.equal(payload.source.lang, 'en', 'source.lang 字面漂移（契约 = en）');
    assert.equal(payload.target.lang, 'zh', 'target.lang 字面漂移（契约 = zh）');
    assert.equal(payload.header.fn, 'auto_translation', 'header.fn 字面漂移（契约 = auto_translation）');
    assert.equal(
      JSON.stringify(payload.source.text_list),
      JSON.stringify(['', '句1', '句2', '']),
      `text_list 首尾空串装配面不符：${JSON.stringify(payload.source.text_list)}`,
    );
  });

  await runCheck('EX-P2B-3 extractQqTranslation 去首尾空串拼接固定向量：[\'\',句1,句2,\'\'] → 句1句2（首尾空串去除、正文逐字保全）', () => {
    assert.equal(typeof qqExtract, 'function', 'extractQqTranslation 未导出（译文拼接未提为可测纯函数）');
    assert.equal(qqExtract!({ ret_code: 'succ', auto_translation: ['', '句1', '句2', ''] }), '句1句2', '去首尾空串拼接固定向量不符（评审 P2-6）');
    // 无空串形态：正文逐字保全
    assert.equal(qqExtract!({ ret_code: 'succ', auto_translation: ['你好', '，世界'] }), '你好，世界', '正文拼接逐字保全面不符');
  });

  await runCheck('EX-P2B-5 extractQqTranslation 全空串拼接 → null（空译文 ≠ 成功态，纯函数面）', () => {
    assert.equal(qqExtract!({ ret_code: 'succ', auto_translation: ['', ''] }), null, '全空串拼接应返回 null（空译文冒充成功面）');
    assert.equal(qqExtract!({ ret_code: 'succ', auto_translation: [] }), null, '空数组应返回 null');
  });

  await runCheck('EX-P2B-6 extractQqTranslation ret_code≠succ → null（纯函数面；ret_code 缺省不钉失败面）', () => {
    assert.equal(qqExtract!({ ret_code: 'error', auto_translation: ['x'] }), null, 'ret_code=error 应返回 null');
    assert.equal(qqExtract!({ ret_code: 'fail', auto_translation: ['x'] }), null, 'ret_code=fail 应返回 null');
    assert.equal(qqExtract!({ ret_code: '', auto_translation: ['x'] }), null, 'ret_code 空串应返回 null');
    // 缺省容面（只钉失败面——对齐 alibaba success 键先例）
    assert.equal(qqExtract!({ auto_translation: ['x'] }), 'x', '无 ret_code 键形态误判失败（提取过严）');
  });

  await runCheck('EX-P2B-7 extractQqTranslation auto_translation 缺失/非数组/非字符串元素 → null（纯函数面）', () => {
    assert.equal(qqExtract!({ ret_code: 'succ' }), null, 'auto_translation 缺失应返回 null（接口改版面）');
    assert.equal(qqExtract!({ ret_code: 'succ', auto_translation: 'str' }), null, 'auto_translation 非数组应返回 null');
    assert.equal(qqExtract!({ ret_code: 'succ', auto_translation: [1, 2] }), null, '元素非字符串应返回 null');
    assert.equal(qqExtract!('not object'), null, '非对象响应应返回 null');
    assert.equal(qqExtract!(null), null, 'null 响应应返回 null');
  });

  // ── E1 · sogou-web 纯函数固定向量组（W2c 点扩容；协议事实 = mt-probe sogou-youdao-iciba-test.ts
  //    实测配方（/text 预热取 cookie → sign → transpc/text/result form POST → data.translate.dit）
  //    + translators-server.py Sogou 节只读采纳：TS 独立实现，零 GPL 代码拷贝进仓库） ──
  console.log('=== E1 · sogou-web 纯函数组（W2c 点扩容） ===');
  const sogouSign = mod.sogouSign as SogouSign | undefined;
  const sogouForm = mod.sogouTranslateForm as SogouTranslateForm | undefined;
  const sogouExtract = mod.extractSogouTranslation as ExtractSogouTranslation | undefined;

  await runCheck('EX-P2C-2 sogouSign 导出且固定向量：md5("en"+"zh-CHS"+"hello"+"109984457") = 12544646d89537920c4c69ced977b2d7（出卷独立计算留痕）+ 拼接序/secretCode 敏感面 + secretCode 常量内建结构面', () => {
    assert.equal(typeof sogouSign, 'function', 'sogouSign 未导出（sign 装配未提为可测纯函数）');
    // 固定向量（出卷侧 node:crypto 独立预计算留痕：12544646d89537920c4c69ced977b2d7）
    const sign = sogouSign!('en', 'zh-CHS', 'hello', '109984457');
    assert.equal(sign, '12544646d89537920c4c69ced977b2d7', `sign 固定向量不符（拼接式漂移）：${sign}`);
    // from+to 拼接序敏感面（EX-P2C-2「谁改了 from+to+text 拼接序」主面：对调 from/to 产物必异）
    const swapped = sogouSign!('zh-CHS', 'en', 'hello', '109984457');
    assert.notEqual(swapped, sign, 'from/to 对调后 sign 不变（拼接序敏感面失效——序漂移不可检）');
    // secretCode 参数敏感面（改一位 secretCode → 产物必异）
    const altCode = sogouSign!('en', 'zh-CHS', 'hello', '109984458');
    assert.notEqual(altCode, sign, 'secretCode 改一位后 sign 不变（secretCode 敏感面失效）');
    // 结构面：secretCode「109984457」常量内建（页面 CONFIG.secretCode 同 translators 硬编码先例）
    assert.ok(enginesSrc.includes("'109984457'"), 'secretCode 109984457 字面不在 engines 源码（常量未内建）');
  });

  await runCheck('EX-P2C-3 sogouTranslateForm form 装配固定向量：8 字段固定序（from=en/to=zh-CHS/text/uuid/s/client=pc/fr=browser_pc/needQc=1）+ to=zh-CHS 字面钉', () => {
    assert.equal(typeof sogouForm, 'function', 'sogouTranslateForm 未导出（form 装配未提为可测纯函数）');
    const form = sogouForm!('hello world', 'e1-sign', 'e1-uuid');
    // vm 侧产物跨 realm 原型 ≠ 宿主（qq 组 2c 先例）——JSON.stringify 字面比对。
    assert.equal(
      JSON.stringify(form),
      JSON.stringify([
        ['from', 'en'],
        ['to', 'zh-CHS'],
        ['text', 'hello world'],
        ['uuid', 'e1-uuid'],
        ['s', 'e1-sign'],
        ['client', 'pc'],
        ['fr', 'browser_pc'],
        ['needQc', '1'],
      ]),
      `form 装配固定向量不符（字段/序漂移）：${JSON.stringify(form)}`,
    );
    // 目标语言字面钉（RB-MT-T11 sogou 面）：to 恰为 'zh-CHS'（非 zh/zh-CN/zh-Hans 漂移）
    assert.equal(form[1]?.[1], 'zh-CHS', 'to 字面漂移（契约 = zh-CHS）');
    assert.equal(form[0]?.[1], 'en', 'from 字面漂移（契约 = en）');
    // uuid/sign 注入透传面：调用方注入什么就装什么（会话级 uuid 与 sign 由会话侧装配）
    assert.equal(form[3]?.[1], 'e1-uuid', 'uuid 未透传进 form');
    assert.equal(form[4]?.[1], 'e1-sign', 'sign 未透传进 form（s 字段）');
  });

  // r3-2-2 收紧时点（2026-11-23）：语义升级为「数值 0 唯一成功形态」显式数字白名单——
  // r2-F 旧判定 `Number(o.status) !== 0` 下 false/' '/[] 经 Number() 归一 0 仍被容忍冒充成功
  // （Number(false)=0、Number(' ')=0、Number([])=0），与 F 组「空串/null 一律判失败」声明规则
  // 自洽性缺口；收紧后 false/''/null/' '/[]/字符串 '0'/非零数字/非数字类型一律失败，键缺省仍容忍。
  await runCheck('EX-P2C-4 extractSogouTranslation status≠0 → null（纯函数面；status 键缺省不钉失败面——对齐 alibaba/qq 先例；r2-F 收紧 status:""/null 判失败；r3-2-2 再收紧：数值 0 唯一成功形态，false/" "/[]/"E100"/字符串\'0\' 一律判失败，status:0 数字仍正常解析）', () => {
    assert.equal(typeof sogouExtract, 'function', 'extractSogouTranslation 未导出（dit 提取未提为可测纯函数）');
    assert.equal(sogouExtract!({ status: 1, errorCode: 0, data: { translate: { dit: 'x' } } }), null, 'status=1 应返回 null（业务失败冒充成功面）');
    assert.equal(sogouExtract!({ status: -1, errorCode: 0, data: { translate: { dit: 'x' } } }), null, 'status=-1 应返回 null');
    // 缺省容面（只钉失败形态判定面——对齐 alibaba success 键先例）
    assert.equal(sogouExtract!({ errorCode: 0, data: { translate: { dit: 'x' } } }), 'x', '无 status 键形态误判失败（提取过严）');
    // r2-F 收紧形态面：空串/null 经 Number() 归一为 0 被容忍的缝隙封堵——一律判失败（与 junk 非数字串同向）
    assert.equal(sogouExtract!({ status: '', errorCode: 0, data: { translate: { dit: 'x' } } }), null, 'status:"" 应返回 null（空串形态改版面，不得归一 0 容忍）');
    assert.equal(sogouExtract!({ status: null, errorCode: 0, data: { translate: { dit: 'x' } } }), null, 'status:null 应返回 null（null 形态改版面，不得归一 0 容忍）');
    // r3-2-2 再收紧形态面：Number(x)===0 容忍缝隙封堵——false/' '/[]/junk 串/字符串 '0' 一律判失败
    assert.equal(sogouExtract!({ status: false, errorCode: 0, data: { translate: { dit: 'x' } } }), null, 'status:false 应返回 null（布尔形态经 Number() 归一 0 冒充成功的缝隙，不得容忍）');
    assert.equal(sogouExtract!({ status: ' ', errorCode: 0, data: { translate: { dit: 'x' } } }), null, 'status:" " 应返回 null（空白串经 Number() 归一 0 冒充成功的缝隙，不得容忍）');
    assert.equal(sogouExtract!({ status: [], errorCode: 0, data: { translate: { dit: 'x' } } }), null, 'status:[] 应返回 null（空数组经 Number() 归一 0 冒充成功的缝隙，不得容忍）');
    assert.equal(sogouExtract!({ status: 'E100', errorCode: 0, data: { translate: { dit: 'x' } } }), null, 'status:"E100" 应返回 null（junk 非数字串）');
    assert.equal(sogouExtract!({ status: '0', errorCode: 0, data: { translate: { dit: 'x' } } }), null, 'status:"0" 字符串零应返回 null（数值 0 唯一成功形态，字符串形态不在白名单）');
    // 合法成功形态不误伤：status:0 显式在场（数字）仍正常解析
    assert.equal(sogouExtract!({ status: 0, errorCode: 0, data: { translate: { dit: 'x' } } }), 'x', 'status:0 显式在场误判失败（成功形态误伤）');
  });

  await runCheck('EX-P2C-5 extractSogouTranslation errorCode≠0 → null（纯函数面；errorCode 键缺省不钉失败面；r2-F 收紧 errorCode:""/null 判失败；r3-2-2 再收紧：数值 0 唯一成功形态，false/" "/[]/布尔形态一律判失败，errorCode:0 数字仍正常解析）', () => {
    assert.equal(sogouExtract!({ status: 0, errorCode: 1, data: { translate: { dit: 'x' } } }), null, 'errorCode=1 应返回 null（错误码冒充成功面）');
    assert.equal(sogouExtract!({ status: 0, errorCode: 'E100', data: { translate: { dit: 'x' } } }), null, 'errorCode 非零 junk 应返回 null');
    // 缺省容面
    assert.equal(sogouExtract!({ status: 0, data: { translate: { dit: 'x' } } }), 'x', '无 errorCode 键形态误判失败（提取过严）');
    // r2-F 收紧形态面：空串/null 归一缝隙封堵——一律判失败（与 junk 非数字串同向）
    assert.equal(sogouExtract!({ status: 0, errorCode: '', data: { translate: { dit: 'x' } } }), null, 'errorCode:"" 应返回 null（空串形态改版面，不得归一 0 容忍）');
    assert.equal(sogouExtract!({ status: 0, errorCode: null, data: { translate: { dit: 'x' } } }), null, 'errorCode:null 应返回 null（null 形态改版面，不得归一 0 容忍）');
    // r3-2-2 再收紧形态面：Number(x)===0 容忍缝隙封堵——false/' '/[]/字符串 '0' 一律判失败（与 status 同改）
    assert.equal(sogouExtract!({ status: 0, errorCode: false, data: { translate: { dit: 'x' } } }), null, 'errorCode:false 应返回 null（布尔形态经 Number() 归一 0 冒充成功的缝隙，不得容忍）');
    assert.equal(sogouExtract!({ status: 0, errorCode: ' ', data: { translate: { dit: 'x' } } }), null, 'errorCode:" " 应返回 null（空白串经 Number() 归一 0 冒充成功的缝隙，不得容忍）');
    assert.equal(sogouExtract!({ status: 0, errorCode: [], data: { translate: { dit: 'x' } } }), null, 'errorCode:[] 应返回 null（空数组经 Number() 归一 0 冒充成功的缝隙，不得容忍）');
    assert.equal(sogouExtract!({ status: 0, errorCode: '0', data: { translate: { dit: 'x' } } }), null, 'errorCode:"0" 字符串零应返回 null（数值 0 唯一成功形态，字符串形态不在白名单）');
    // 合法成功形态不误伤：errorCode:0 显式在场（数字）仍正常解析
    assert.equal(sogouExtract!({ status: 0, errorCode: 0, data: { translate: { dit: 'x' } } }), 'x', 'errorCode:0 显式在场误判失败（成功形态误伤）');
  });

  await runCheck('EX-P2C-6 extractSogouTranslation dit 缺失/空串/非字符串/中间层缺失 → null + 成功固定向量 data.translate.dit（评审 P2-6）', () => {
    // 成功固定向量：响应 data.translate.dit 即译文
    assert.equal(sogouExtract!({ status: 0, errorCode: 0, data: { translate: { dit: '你好，世界。' } } }), '你好，世界。', '成功固定向量提取不符');
    // dit 缺失/空/非字符串（EX-P2C-6 主面：接口改版面）
    assert.equal(sogouExtract!({ status: 0, errorCode: 0 }), null, 'data 缺失应返回 null');
    assert.equal(sogouExtract!({ status: 0, errorCode: 0, data: {} }), null, 'translate 缺失应返回 null');
    assert.equal(sogouExtract!({ status: 0, errorCode: 0, data: { translate: {} } }), null, 'dit 缺失应返回 null（接口改版面）');
    assert.equal(sogouExtract!({ status: 0, errorCode: 0, data: { translate: { dit: '' } } }), null, '空译文应返回 null（空译文 ≠ 成功态）');
    assert.equal(sogouExtract!({ status: 0, errorCode: 0, data: { translate: { dit: 123 } } }), null, 'dit 非字符串应返回 null');
    assert.equal(sogouExtract!('not object'), null, '非对象响应应返回 null');
    assert.equal(sogouExtract!(null), null, 'null 响应应返回 null');
  });

  // ── E1 · youdao-web V2 纯函数固定向量组（W2d 点扩容；协议事实 = 2026-11-22 真网复现实测
  //    （page/js/key/translate 全链 200 出译文）+ mt-probe sogou-youdao-iciba-test.ts 实测配方
  //    + translators-server.py YoudaoV2 节只读采纳：TS 独立实现，零 GPL 代码拷贝进仓库） ──
  console.log('=== E1 · youdao-web V2 纯函数组（W2d 点扩容） ===');
  const youdaoSignFn = mod.youdaoSign as YoudaoSign | undefined;
  const youdaoKeyQueryFn = mod.youdaoKeyQuery as YoudaoKeyQuery | undefined;
  const youdaoTranslateFormFn = mod.youdaoTranslateForm as YoudaoTranslateForm | undefined;
  const parseYoudaoKey = mod.parseYoudaoKeyResponse as ParseYoudaoKeyResponse | undefined;
  const extractDefaultKey = mod.extractYoudaoDefaultKey as ExtractYoudaoDefaultKey | undefined;
  const extractDecodeParts = mod.extractYoudaoDecodeParts as ExtractYoudaoDecodeParts | undefined;
  const aesSecretBytes = mod.youdaoAesSecretBytes as YoudaoAesSecretBytes | undefined;
  const youdaoDecryptFn = mod.youdaoDecrypt as YoudaoDecrypt | undefined;
  const extractYoudaoText = mod.extractYoudaoTranslation as ExtractYoudaoTranslation | undefined;

  await runCheck('EX-P2D-2 youdaoSign 导出且双 sign 式固定向量：defaultKey 版 8d477acb24abb7dd93e7618ac54caece + secretKey 版 3d42b8c6e706ea20457cdf760fd716ae（出卷独立计算留痕）+ 拼接模板敏感面', () => {
    assert.equal(typeof youdaoSignFn, 'function', 'youdaoSign 未导出（sign 装配未提为可测纯函数）');
    // ① key 接口 defaultKey 版（出卷向量：md5 拼接模板字面 + key=webfanyi-key-getter-2025 输入）
    const signKeyid = youdaoSignFn!('1700000000000', 'webfanyi-key-getter-2025');
    assert.equal(signKeyid, '8d477acb24abb7dd93e7618ac54caece', `sign 固定向量①不符（拼接模板漂移）：${signKeyid}`);
    // ② translate 同式换 secretKey 版（同模板、key 换 secretKey、时间推进一位）
    const signSecret = youdaoSignFn!('1700000000001', '0123456789abcdef');
    assert.equal(signSecret, '3d42b8c6e706ea20457cdf760fd716ae', `sign 固定向量②不符（第二步未换 secretKey 或模板漂移）：${signSecret}`);
    // 敏感面：key 改一位 / 时间改一位 → 产物必异（模板拼接序漂移不可检面双保险）
    assert.notEqual(youdaoSignFn!('1700000000000', 'yU5nT5dK3eZ1pI4j'), signKeyid, 'key 改换后 sign 不变（key 敏感面失效）');
    assert.notEqual(youdaoSignFn!('1700000000002', 'webfanyi-key-getter-2025'), signKeyid, 'mysticTime 改后 sign 不变（时间敏感面失效）');
  });

  await runCheck('EX-P2D-2b youdaoKeyQuery key 接口查询装配固定向量：15 字段固定序 + sign 字段即 EX-P2D-2① 固定向量', () => {
    assert.equal(typeof youdaoKeyQueryFn, 'function', 'youdaoKeyQuery 未导出（key 查询装配未提为可测纯函数）');
    const query = youdaoKeyQueryFn!('1700000000000', 'webfanyi-key-getter-2025');
    // vm 侧产物跨 realm 原型 ≠ 宿主（alibaba 组 2c 先例）——JSON.stringify 字面比对。
    assert.equal(
      JSON.stringify(query),
      JSON.stringify([
        ['keyid', 'webfanyi-key-getter-2025'],
        ['mysticTime', '1700000000000'],
        ['sign', '8d477acb24abb7dd93e7618ac54caece'],
        ['client', 'fanyideskweb'],
        ['product', 'webfanyi'],
        ['appVersion', '12.0.0'],
        ['vendor', 'web'],
        ['keyfrom', 'fanyi.web'],
        ['pointParam', 'client,mysticTime,product'],
        ['yduuid', 'abcdefg'],
        ['mid', '1'],
        ['screen', '1'],
        ['model', '1'],
        ['network', 'wifi'],
        ['abtest', '0'],
      ]),
      `key 查询装配固定向量不符（字段/序漂移）：${JSON.stringify(query)}`,
    );
    assert.equal(query[0]?.[1], 'webfanyi-key-getter-2025', 'keyid 字面漂移（契约 = webfanyi-key-getter-2025）');
  });

  await runCheck('EX-P2D-2c youdaoTranslateForm 翻译 POST form 装配固定向量：20 字段固定序 + sign 字段即 EX-P2D-2② + to=zh-CHS 字面钉（RB-MT-T11 youdao 面）', () => {
    assert.equal(typeof youdaoTranslateFormFn, 'function', 'youdaoTranslateForm 未导出（翻译 form 装配未提为可测纯函数）');
    const form = youdaoTranslateFormFn!('hello world', '1700000000001', '0123456789abcdef');
    assert.equal(
      JSON.stringify(form),
      JSON.stringify([
        ['i', 'hello world'],
        ['from', 'en'],
        ['to', 'zh-CHS'],
        ['dictResult', 'true'],
        ['useTerm', 'false'],
        ['keyid', 'webfanyi'],
        ['mysticTime', '1700000000001'],
        ['sign', '3d42b8c6e706ea20457cdf760fd716ae'],
        ['client', 'fanyideskweb'],
        ['product', 'webfanyi'],
        ['appVersion', '12.0.0'],
        ['vendor', 'web'],
        ['keyfrom', 'fanyi.web'],
        ['pointParam', 'client,mysticTime,product'],
        ['yduuid', 'abcdefg'],
        ['mid', '1'],
        ['screen', '1'],
        ['model', '1'],
        ['network', 'wifi'],
        ['abtest', '0'],
      ]),
      `翻译 form 装配固定向量不符（字段/序漂移）：${JSON.stringify(form)}`,
    );
    // 目标语言字面钉（RB-MT-T11 youdao 面）：to 恰为 'zh-CHS'（非 zh/zh-CN/zh-Hans 漂移）
    assert.equal(form[2]?.[1], 'zh-CHS', 'to 字面漂移（契约 = zh-CHS）');
    assert.equal(form[1]?.[1], 'en', 'from 字面漂移（契约 = en）');
    // 载荷面：keyid=webfanyi（≠ key 接口的 webfanyi-key-getter-2025——第二步换 keyid 面）
    assert.equal(form[5]?.[1], 'webfanyi', 'translate 载荷 keyid 字面漂移（契约 = webfanyi）');
    assert.equal(form[0]?.[1], 'hello world', '段文本未透传进 i 字段');
  });

  await runCheck('EX-P2D-2d 内建常量结构面：keyid/default key 实值/decodeKey/decodeIv 四常量字面在 engines 源码（P2-3 常量内建）', () => {
    assert.ok(enginesSrc.includes("'webfanyi-key-getter-2025'"), 'keyid webfanyi-key-getter-2025 字面不在 engines 源码（常量未内建）');
    assert.ok(enginesSrc.includes("'yU5nT5dK3eZ1pI4j'"), 'default key 实值 yU5nT5dK3eZ1pI4j 字面不在 engines 源码（内建缺失——happy path 零 js 下载破坏面）');
    assert.ok(enginesSrc.includes("'ydsecret://query/key/B*RGyg"), 'decodeKey 兜底常量字面不在 engines 源码');
    assert.ok(enginesSrc.includes("'ydsecret://query/iv/C@lZe2Yz"), 'decodeIv 兜底常量字面不在 engines 源码');
  });

  await runCheck('EX-P2D-3a youdaoAesSecretBytes 密钥派生定量向量：md5("test-aes-key") 摘要 16 字节逐字节比对（16 字节摘要整体解释）', () => {
    assert.equal(typeof aesSecretBytes, 'function', 'youdaoAesSecretBytes 未导出（密钥派生未提为可测纯函数）');
    const keyBytes = aesSecretBytes!('test-aes-key');
    assert.equal(
      JSON.stringify(keyBytes),
      JSON.stringify(YOUDAO_AES_KEY_BYTES),
      `密钥派生定量向量不符（取摘要整体/取 hex 位/错位漂移）：${JSON.stringify(keyBytes)}`,
    );
    assert.equal(keyBytes.length, 16, `派生产物非 16 字节：${keyBytes.length}`);
    const ivBytes = aesSecretBytes!('test-aes-iv');
    assert.equal(JSON.stringify(ivBytes), JSON.stringify(YOUDAO_AES_IV_BYTES), 'iv 侧派生定量向量不符');
    // 敏感面：不同输入 → 不同派生
    assert.notEqual(JSON.stringify(aesSecretBytes!('other-input')), JSON.stringify(YOUDAO_AES_KEY_BYTES), '输入改后派生不变（敏感面失效）');
  });

  await runCheck('EX-P2D-3b youdaoDecrypt 解密定量向量（不触网）：备选向量密文 + test-aes-key/test-aes-iv → 明文 JSON 逐字（派生错 = 解密必败横向钉死）', () => {
    assert.equal(typeof youdaoDecryptFn, 'function', 'youdaoDecrypt 未导出（解密未提为可测纯函数）');
    const plain = youdaoDecryptFn!(YOUDAO_CIPHER_VECTOR, 'test-aes-key', 'test-aes-iv');
    assert.equal(plain, YOUDAO_PLAIN_VECTOR, `解密定量向量不符（派生/模式/padding/base64url 漂移）：${plain?.slice(0, 80)}`);
  });

  await runCheck('EX-P2D-6 youdaoDecrypt 失败形态 → null：空串/非法 base64url/坏密文（解密失败不挂起不冒充成功）', () => {
    assert.equal(youdaoDecryptFn!('', 'test-aes-key', 'test-aes-iv'), null, '空密文应返回 null');
    assert.equal(youdaoDecryptFn!('not base64url !!!', 'test-aes-key', 'test-aes-iv'), null, '非法 base64url 应返回 null');
    // 坏密文：合法 base64url 但非本 key 加密（PKCS7 卸垫失败面）
    assert.equal(youdaoDecryptFn!('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'test-aes-key', 'test-aes-iv'), null, '坏密文应返回 null（卸垫失败）');
    assert.equal(youdaoDecryptFn!(YOUDAO_CIPHER_VECTOR, 'wrong-key', 'test-aes-iv'), null, 'key 错应返回 null（不冒充成功）');
  });

  await runCheck('EX-P2D-4a extractYoudaoDefaultKey 固定向量：真网 js 形态 → yU5nT5dK3eZ1pI4j + 抽象形态 k="v" 容面 + js 无形态 → null（内建兜底触发面）', () => {
    assert.equal(typeof extractDefaultKey, 'function', 'extractYoudaoDefaultKey 未导出（default_key 提取未提为可测纯函数）');
    assert.equal(extractDefaultKey!(YOUDAO_JS_REAL), 'yU5nT5dK3eZ1pI4j', `真网 js 形态提取不符：${String(extractDefaultKey!(YOUDAO_JS_REAL))}`);
    assert.equal(extractDefaultKey!(YOUDAO_JS_ABSTRACT), 'v', '出卷抽象形态（k="v"）提取不符（形态容面失效）');
    assert.equal(extractDefaultKey!(YOUDAO_JS_BARE), null, 'js 无该形态应返回 null（调用方内建常量兜底）');
    assert.equal(extractDefaultKey!(''), null, '空 js 应返回 null');
  });

  await runCheck('EX-P2D-4b extractYoudaoDecodeParts 固定向量：真网实值形态提取 + js 无形态 → null 双兜底（decodeKey/decodeIv 兜底值源面）', () => {
    assert.equal(typeof extractDecodeParts, 'function', 'extractYoudaoDecodeParts 未导出（decodeKey/decodeIv 提取未提为可测纯函数）');
    const parts = extractDecodeParts!(YOUDAO_JS_DECODE);
    assert.equal(parts.decodeKey, 'ydsecret://query/key/B*RGygVywfNBwpmBaZg*WT7SIOUP2T0C9WHMZN39j^DAdaZhAnxvGcCY6VYFwnHl', `decodeKey 提取不符：${parts.decodeKey}`);
    assert.equal(parts.decodeIv, 'ydsecret://query/iv/C@lZe2YzHtZ2CYgaXKSVfsb7Y4QWHjITPPZ0nQp87fBeJ!Iv6v^6fvi2WN@bYpJ4', `decodeIv 提取不符：${parts.decodeIv}`);
    const bare = extractDecodeParts!(YOUDAO_JS_BARE);
    assert.equal(bare.decodeKey, null, 'js 无 decodeKey 形态应为 null（内建兜底触发面）');
    assert.equal(bare.decodeIv, null, 'js 无 decodeIv 形态应为 null（内建兜底触发面）');
  });

  await runCheck('EX-P2D-5 parseYoudaoKeyResponse：成功向量 {data:{secretKey,aesKey,aesIv}} → 产物 + secretKey 缺失/空/非字符串/非 JSON/data 缺失 → null（EX-P2D-5 纯函数面）', () => {
    assert.equal(typeof parseYoudaoKey, 'function', 'parseYoudaoKeyResponse 未导出（key 响应解析未提为可测纯函数）');
    const parts = parseYoudaoKey!('{"data":{"secretKey":"SRz6r3IGA6lj9i5zW0OYqgVZOtLDQe3E","aesKey":"k-e1","aesIv":"i-e1"}}');
    assert.ok(parts, '成功向量解析产物为 null');
    assert.equal(parts.secretKey, 'SRz6r3IGA6lj9i5zW0OYqgVZOtLDQe3E', 'secretKey 提取不符');
    assert.equal(parts.aesKey, 'k-e1', 'aesKey 透传不符');
    assert.equal(parts.aesIv, 'i-e1', 'aesIv 透传不符');
    // aesKey/aesIv 缺省 → ''（调用方内建兜底面；secretKey 在场链仍通）
    const minimal = parseYoudaoKey!('{"data":{"secretKey":"s-only"}}');
    assert.ok(minimal, '仅 secretKey 响应解析产物为 null（aesKey/aesIv 缺省不应整包失败）');
    assert.equal(minimal.aesKey, '', 'aesKey 缺省应出空串（调用方兜底面）');
    assert.equal(minimal.aesIv, '', 'aesIv 缺省应出空串（调用方兜底面）');
    // secretKey 必需面（EX-P2D-5 主面：key 接口无 secretKey → 失败降级）
    assert.equal(parseYoudaoKey!('{"data":{"aesKey":"k","aesIv":"i"}}'), null, 'secretKey 缺失应返回 null');
    assert.equal(parseYoudaoKey!('{"data":{"secretKey":""}}'), null, 'secretKey 空串应返回 null');
    assert.equal(parseYoudaoKey!('{"data":{"secretKey":123}}'), null, 'secretKey 非字符串应返回 null');
    assert.equal(parseYoudaoKey!('{"code":1,"msg":"request error"}'), null, 'data 缺失（错误响应形态）应返回 null');
    assert.equal(parseYoudaoKey!('not json'), null, '非 JSON 应返回 null');
    assert.equal(parseYoudaoKey!(''), null, '空响应应返回 null');
  });

  await runCheck('EX-P2D-7 extractYoudaoTranslation：translateResult[[{tgt}]] 展平拼接固定向量（P2-6 逐字保全）+ 缺失/空/残缺 → null（EX-P2D-7 纯函数面）', () => {
    assert.equal(typeof extractYoudaoText, 'function', 'extractYoudaoTranslation 未导出（tgt 拼接未提为可测纯函数）');
    // 成功固定向量：多行展平拼接、逐字保全（评审 P2-6）
    assert.equal(extractYoudaoText!({ translateResult: [[{ tgt: '你好' }], [{ tgt: '，世界' }]] }), '你好，世界', '多行拼接固定向量不符（评审 P2-6）');
    assert.equal(extractYoudaoText!({ translateResult: [[{ tgt: '你好，世界。' }]] }), '你好，世界。', '单行固定向量不符');
    // 行内多 cell 形态：同 row 双 tgt 顺拼
    assert.equal(extractYoudaoText!({ translateResult: [[{ tgt: '你' }, { tgt: '好' }]] }), '你好', '行内多 cell 拼接不符');
    // translateResult 缺失/残缺（EX-P2D-7 主面：接口改版面）
    assert.equal(extractYoudaoText!({}), null, 'translateResult 缺失应返回 null');
    assert.equal(extractYoudaoText!({ translateResult: 'str' }), null, 'translateResult 非数组应返回 null');
    assert.equal(extractYoudaoText!({ translateResult: [] }), null, '空数组应返回 null');
    assert.equal(extractYoudaoText!({ translateResult: [[]] }), null, '空行拼接应返回 null（空译文 ≠ 成功态）');
    assert.equal(extractYoudaoText!({ translateResult: [1] }), null, '行非数组应返回 null');
    assert.equal(extractYoudaoText!({ translateResult: [['x']] }), null, '元素非对象应返回 null');
    assert.equal(extractYoudaoText!({ translateResult: [[{ tgt: 123 }]] }), null, 'tgt 非字符串应返回 null');
    assert.equal(extractYoudaoText!('not object'), null, '非对象响应应返回 null');
    assert.equal(extractYoudaoText!(null), null, 'null 响应应返回 null');
  });

  await runCheck('EX-P2D-13 结构钉（V1 整函数删除）：translate_o/YOUDAO_KEY_DEFAULT/youdaoForm/youdaoKeyCache/老 sign 拼接/老 key 字面/extractYoudaoKey( 零命中', () => {
    for (const literal of ['translate_o', 'YOUDAO_KEY_DEFAULT', 'youdaoForm', 'youdaoKeyCache', 'fanyideskweb${segment', "'n%A-rKaT5fb[Gy?;N5@Tj'", 'extractYoudaoKey('] as const) {
      assert.ok(!enginesSrc.includes(literal), `V1 残留字面命中（V1 未删净）：${literal}`);
    }
  });

  await runCheck('EX-P2D-12 结构面（P1-5 endpoint 不消费）：makeYoudaoWeb 函数体 void ctx + 代码面 ctx.entry.endpoint / DEFAULT_YOUDAO_WEB_ENDPOINT 零命中（youdao 段切片、剥注释后判定）', () => {
    const youdaoStart = enginesSrc.indexOf('// ── youdao-web');
    const youdaoEnd = enginesSrc.indexOf('// ── baidu-web');
    assert.ok(youdaoStart >= 0 && youdaoEnd > youdaoStart, `youdao 段定位失败（${youdaoStart}..${youdaoEnd}）`);
    const section = enginesSrc.slice(youdaoStart, youdaoEnd);
    assert.ok(section.includes('void ctx'), 'makeYoudaoWeb 缺 void ctx（endpoint 非消费声明形态，沿 alibaba/qq/sogou 先例）');
    // 代码面零命中（剥 // 行注释后判定——注释里的「不消费」声明字面不是消费，钉的是代码消费面）
    const codeOnly = section.replace(/\/\/[^\n]*/g, '');
    assert.ok(!codeOnly.includes('ctx.entry.endpoint'), 'youdao V2 适配器代码消费 entry.endpoint（P1-5 违约——脏值改写出站面）');
    assert.ok(!codeOnly.includes('DEFAULT_YOUDAO_WEB_ENDPOINT'), 'youdao 段代码残留 DEFAULT_YOUDAO_WEB_ENDPOINT 消费');
  });

  // ── E1 · W5 注册/付费层整链移除负向钉（p6 点扩容；EX-P6 组 = 01 清单 §6） ──
  // 评审依据：P2-5（清键钉 getConfig 读路径）/ P2-7（unavailable 机械面保留休眠，零行为可断不出例）/
  // P1-4 条 3（「添加引擎」整块删除）与条 5（凭据表单段删除）。
  console.log('=== E1 · W5 tencent-tmt + custom-template 整链移除负向钉（p6 点扩容） ===');

  const p6Files: Array<[string, string]> = [
    ['engines', enginesSrc],
    ['service', serviceSrc],
    ['core', coreSrc],
    ['config-manager', configManagerSrc],
    ['types/config', configTypesSrc],
    ['ConfigPage', configPageSrc],
  ];

  await runCheck('EX-P6-1 结构钉（tencent 链删净）：适配器/TC3 签名族/节流/kind/类型/常量/config-manager 凭据链四件——六源码字面零命中（config-manager 唯一豁免面 = P2-5 读路径清键字面）', () => {
    const tencentLiterals = [
      'makeTencentTmt',
      'waitTencentInterval',
      'tencentLastRequestAt',
      'TC3-HMAC-SHA256',
      'tc3_request',
      'tencentcloudapi',
      'X-TC-Action',
      'DEFAULT_TENCENT_TMT_ENDPOINT',
      'TRANSLATION_TENCENT_',
      'TENCENT_CREDENTIALS_KEY',
      'interceptTencentCredentialFields',
      'decryptTencentCredentialParts',
      'readTencentCredentialsBlob',
      'getDecryptedTencentCredentials',
      'encryptCredential',
      'decryptCredentialField',
      'nullCredentialCipher',
      'maskCredentialValue',
      'CredentialCipher',
      'TencentCredentials',
      'tencentSecretId',
      'tencentSecretKey',
      'tencentCredentialsBroken',
      'tencent-tmt',
    ] as const;
    for (const [name, src] of p6Files) {
      // config-manager 唯一豁免面 = P2-5 读路径清键字面（EX-P6-2 另钉其恰一处与读路径钉位）；
      // 豁免先于逐字面与毯扫两道（清键字面自身含 'TencentCredentials' 子串）。
      const scan = name === 'config-manager' ? src.split('translationTencentCredentials').join('') : src;
      for (const literal of tencentLiterals) {
        assert.ok(!scan.includes(literal), `${name} 残留 tencent 链字面（W5 应删未删）：${literal}`);
      }
      // 兜底毯扫（大小写不敏感，含注释——残留注释即删净未完成的可见面）。
      assert.ok(!/tencent|tc3/i.test(scan), `${name} 源码 /tencent|tc3/i 兜底毯扫命中（清单字面之外的残留）`);
    }
  });

  await runCheck('EX-P6-2 存量凭据键一次性清键（P2-5）：store stub 带 translationTencentCredentials → 真实 getConfig 读路径读后键消失 + 二次读幂等不报错 + delete 调用次数钉（首读恰 1 次、二次读零 delete）+ 清键恰钉在读路径而非 sanitize', () => {
    const stub = loadConfigManagerWithStore({
      translationTencentCredentials: {
        secretId: { encrypted: 'e1-old-secret', encoding: 'plain' },
        secretKey: { encrypted: 'e1-old-key', encoding: 'plain' },
      },
    });
    assert.ok('translationTencentCredentials' in stub.data, '前置失败：store stub 未携带存量凭据键');
    assert.doesNotThrow(() => stub.mod.getConfig(), '首次 getConfig 抛错（读路径断裂）');
    assert.ok(!('translationTencentCredentials' in stub.data), '读后凭据键仍在盘上（P2-5 一次性清键未接线——存量密文残留面）');
    // 行为钉①（删净契约本体）：存量键存在时首读恰 1 次 delete。
    assert.equal(
      stub.deleteCalls.length, 1,
      `首次 getConfig delete 调用 ${stub.deleteCalls.length} 次（存量键存在应恰 1 次删净；deleteCalls=${JSON.stringify(stub.deleteCalls)}）`,
    );
    assert.doesNotThrow(() => stub.mod.getConfig(), '二次 getConfig 报错（清键非幂等）');
    assert.ok(!('translationTencentCredentials' in stub.data), '二次读后凭据键复活');
    // 行为钉②（round-002 B-1 / r2-F-1）：同一 store 连续第二次 getConfig 零 delete 调用——
    // conf@14.0.0 delete 终态无条件 this.store=store → _ensureDirectory+_validate+_write+
    // dispatchEvent(change)，键不存在同样全量落盘；无存在性守卫即每次 getConfig 热路径 IO
    // 放大，「一次性」契约偏离。
    assert.equal(
      stub.deleteCalls.length, 1,
      `二次 getConfig 仍发 delete 调用（deleteCalls=${JSON.stringify(stub.deleteCalls)}；存在性守卫缺失——conf@14.0.0 delete 对不存在键同样全量落盘 + change 事件，热路径 IO 放大）`,
    );
    // 结构面：清键钉在读路径（config-manager 代码面恰一处 delete 调用），sanitize 纯函数零 store 访问。
    // 凭据密文销毁不可逆（用户已知悉留痕——见 p6 实施报告）。
    const cmCode = configManagerSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const hits = cmCode.split("delete('translationTencentCredentials'").length - 1;
    assert.equal(hits, 1, `config-manager 代码面 delete('translationTencentCredentials') 出现 ${hits} 次（应恰 1 处、钉在 getConfig 读路径）`);
    assert.ok(!coreSrc.includes('translationTencentCredentials'), 'sanitize（translation-core）出现凭据键字面（P2-5 违约：清键漏进纯函数）');
    assert.ok(!coreSrc.includes('getStore'), 'translation-core 出现 store 访问字面（sanitize 必须纯函数）');
  });

  await runCheck('EX-P6-3 结构钉（凭据表单/探面「未配置凭据」形态删净）：ConfigPage TranslationCredentialView import/凭据表单段/凭据徽标/文案字面零命中', () => {
    for (const literal of [
      'TranslationCredentialView',
      'trTencentCredState',
      'saveTencentCredentials',
      'trSecretIdInput',
      'trSecretKeyInput',
      'trCredSavePending',
      'tr-cred',
      'translate-tencent-cred-badge',
      '未配置凭据',
      '腾讯云凭据',
    ] as const) {
      assert.ok(!configPageSrc.includes(literal), `ConfigPage 凭据控件残留字面（W5 P1-4 条 5 应删未删）：${literal}`);
    }
  });

  await runCheck('EX-P6-4 结构钉（custom-template 链删净）：适配器/kind/类型/字段（含 service 落盘载荷键）/templateName 引用链——六源码零命中 + ConfigPage 自定义模板编辑区与「添加引擎」整块零命中', () => {
    const chainLiterals = ['makeCustomTemplate', 'custom-template', 'TranslationCustomTemplate', 'customTemplates', 'templateName'] as const;
    for (const [name, src] of p6Files) {
      for (const literal of chainLiterals) {
        assert.ok(!src.includes(literal), `${name} 残留 custom-template 链字面（W5 应删未删）：${literal}`);
      }
    }
    // ConfigPage「添加引擎」整块（P1-4 条 3 终态裁决：无任何可添加 kind，整块删）+ 自定义模板编辑区。
    for (const literal of [
      'trAddKind',
      'addTranslationEngine',
      'hasTencentEngine',
      'genTranslationEngineId',
      'removeTranslationEngine',
      'tr-eng-add',
      '添加引擎',
      'trTemplateForm',
      'TranslationTemplateFormState',
      'openTranslationTemplateForm',
      'cancelTranslationTemplateForm',
      'saveTranslationTemplateForm',
      'tr-tpl',
      '自定义模板',
    ] as const) {
      assert.ok(!configPageSrc.includes(literal), `ConfigPage 添加引擎/自定义模板编辑区残留字面：${literal}`);
    }
  });

  // ── EX-P7 清理负向钉组（2026-11-22 扩容批次 p7/W4：baidu-web 死引擎清理 + google-gtx 用户
  //  裁决剔除「谷歌先剔除掉」+ 种子重排 + 配置迁移；出卷清单 §7）──

  // EX-P7-1 钉面口径：全源码面（含注释）钉「引号 kind 字面 / 死符号名 / 死端点 URL」零命中——
  // 删除留痕注释以非引号、非符号名、非 URL 形态书写（'seed-google-gtx' 含 google-gtx 子串但
  // 不含引号形态 `'google-gtx'`，迁移规则代码可与引号钉共存）；代码面（剥注释）另做
  // /google|baidu/i 毯扫兜底（圈外 config-manager/service 注释残留不在毯扫面，留痕申报）。
  await runCheck('EX-P7-1 结构钉（baidu-web/google-gtx 整链删净）：kind 联合/白名单引号字面零命中 + 死引擎适配器/端点常量符号名零命中 + 死端点 URL 字面零命中（全源码面含注释）+ engines/core/types/ConfigPage 代码面毯扫零命中', () => {
    const p7Files: Array<[string, string]> = [
      ['engines', enginesSrc],
      ['service', serviceSrc],
      ['core', coreSrc],
      ['config-manager', configManagerSrc],
      ['types', configTypesSrc],
      ['ConfigPage', configPageSrc],
    ];
    // 全源码面（含注释）：kind 引号字面（白名单数组/kind 联合/dispatch 分支/名称与端点映射的全部
    // 形态）+ 死符号名（适配器函数与端点常量，含 import 面）+ 死端点 URL 字面。
    for (const [name, src] of p7Files) {
      for (const literal of ["'google-gtx'", "'baidu-web'"]) {
        assert.ok(!src.includes(literal), `${name} 残留死 kind 引号字面（W4 p7 应删未删）：${literal}`);
      }
      for (const literal of ['makeGoogleGtx', 'makeBaiduWeb', 'DEFAULT_GOOGLE_GTX_ENDPOINT', 'DEFAULT_BAIDU_WEB_ENDPOINT']) {
        assert.ok(!src.includes(literal), `${name} 残留死引擎符号名（W4 p7 应删未删）：${literal}`);
      }
      for (const literal of ['translate_a/single?client=gtx', 'v2transapi', 'translate.googleapis.com']) {
        assert.ok(!src.includes(literal), `${name} 残留死引擎端点 URL 字面（W4 p7 应删未删）：${literal}`);
      }
    }
    // 代码面毯扫（剥注释后 /google|baidu/i——// 与 /* */ 与 Vue 模板 <!-- --> 三形态；core 豁免面 =
    // 迁移规则 seed id 字面——剔除行为本体，EX-P7-2 承载；config-manager/service 的圈外注释残留
    // 不进代码面毯扫）。
    const stripComments = (src: string): string =>
      src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
    for (const [name, src] of [['engines', enginesSrc], ['core', coreSrc], ['types', configTypesSrc], ['ConfigPage', configPageSrc]] as const) {
      let scan = stripComments(src);
      if (name === 'core') {
        scan = scan.split('seed-google-gtx').join('').split('seed-baidu-web').join('');
      }
      assert.ok(!/google|baidu/i.test(scan), `${name} 代码面 /google|baidu/i 兜底毯扫命中（清单字面之外的残留）`);
    }
  });

  await runCheck('EX-P7-2 行为钉（两 seed id 经 sanitize 消失 + 存量四种子读路径归一恰五引擎）：seed-google-gtx/seed-baidu-web 剔除、seed-bing-web/seed-youdao-web 保留、缺席三种子补齐 → 恰五条', () => {
    const clean = translationCore.sanitizeTranslationConfig({
      engines: [
        { id: 'seed-google-gtx', kind: 'google-gtx', enabled: true, order: 0 },
        { id: 'seed-bing-web', kind: 'bing-web', enabled: true, order: 1 },
        { id: 'seed-youdao-web', kind: 'youdao-web', enabled: true, order: 2 },
        { id: 'seed-baidu-web', kind: 'baidu-web', enabled: true, order: 3 },
      ],
    });
    assert.ok(!clean.engines.some((e) => e.id === 'seed-google-gtx'), 'seed-google-gtx 未被 sanitize 剔除（W4 清理面）');
    assert.ok(!clean.engines.some((e) => e.id === 'seed-baidu-web'), 'seed-baidu-web 未被 sanitize 剔除（W4 清理面）');
    assert.ok(clean.engines.some((e) => e.id === 'seed-bing-web'), 'seed-bing-web 被误剔（存活种子）');
    assert.ok(clean.engines.some((e) => e.id === 'seed-youdao-web'), 'seed-youdao-web 被误剔（W2d V2 重写后保留）');
    // 补齐面：缺席的 alibaba/qq/sogou 三种子自动追加 → 恰五条（order 单调面在 core 卷 T-迁-3 钉）。
    assert.equal(clean.engines.length, 5, `存量四种子读路径应归一恰五引擎（实际 ${clean.engines.length}）`);
    for (const id of ['seed-alibaba-web', 'seed-qq-transmart', 'seed-sogou-web']) {
      assert.ok(clean.engines.some((e) => e.id === id), `规范种子 ${id} 未补齐`);
    }
    const kinds = clean.engines.map((e) => e.kind);
    assert.deepEqual([...kinds].sort(), ['alibaba-web', 'bing-web', 'qq-transmart', 'sogou-web', 'youdao-web'], `归一后 kind 集不符：${kinds.join(',')}`);
  });

  await runCheck('EX-P7-3 出厂五元终序钉：DEFAULT_TRANSLATION_ENGINES 恰五条、kind 序 [bing,alibaba,qq,sogou,youdao]、order 0..4、id 全 seed-* 规范字面、全 enabled、全直连（useProxy !== true）', () => {
    const seeds = translationCore.DEFAULT_TRANSLATION_ENGINES;
    assert.equal(seeds.length, 5, `出厂种子应恰五条（实际 ${seeds.length}）`);
    assert.deepEqual(
      seeds.map((e) => e.kind),
      ['bing-web', 'alibaba-web', 'qq-transmart', 'sogou-web', 'youdao-web'],
      `出厂五元终序不符：${seeds.map((e) => e.kind).join(',')}`,
    );
    assert.deepEqual(seeds.map((e) => e.order), [0, 1, 2, 3, 4], `出厂 order 不符：${seeds.map((e) => e.order).join(',')}`);
    assert.deepEqual(
      seeds.map((e) => e.id),
      ['seed-bing-web', 'seed-alibaba-web', 'seed-qq-transmart', 'seed-sogou-web', 'seed-youdao-web'],
      '种子 id 应为规范 seed-* 字面',
    );
    assert.ok(seeds.every((e) => e.enabled === true), '出厂五条必须全 enabled');
    assert.ok(seeds.every((e) => e.useProxy !== true), '出厂五条全直连零代理依赖（google 剔除后无 useProxy 出厂面）');
    // 白名单负向面（behavioral）：两死 kind 条目整条丢弃（kind 引号字面钉在 EX-P7-1）。
    const rejected = translationCore.sanitizeTranslationConfig({
      engines: [
        { id: 'x1', kind: 'baidu-web', enabled: true, order: 0 },
        { id: 'x2', kind: 'google-gtx', enabled: true, order: 1 },
      ],
    });
    assert.ok(rejected.engines.every((e) => e.kind !== 'baidu-web' && e.kind !== 'google-gtx'), '死 kind 条目未被白名单剔除');
    assert.equal(rejected.engines.length, 5, '白名单剔除后应仅剩补齐的五规范种子');
  });

  // ── EX-P8 代理回撤 + UX 修订组（2026-11-22 扩容批次 p8/W4 P1-B + 评审 P2-1/P2-2；出卷清单 §8）──

  // EX-P8-1 钉面口径：types/config 与 config-manager 全源码面（含注释）proxyUrl 零命中（字段删除 +
  // 删除留痕注释不得再引字段名）；engines 钉闭包接线字面 config.proxyUrl 零命中（休眠机械面
  // resolveOutboundProxy 第二参签名保留，显式值形参名 explicitProxyUrl 与接线字面不冲突）。
  await runCheck('EX-P8-1 结构钉（代理面回撤）：types/config 无 translation.proxyUrl 字段 + config-manager 源零 proxyUrl + engines 闭包接线字面零命中 + service 落盘透传字面零命中', () => {
    assert.ok(!/proxyUrl/.test(configTypesSrc), 'types/config.ts 残留 proxyUrl 字段/注释字面（W4 P1-B 应删未删）');
    assert.ok(!/proxyUrl/.test(configManagerSrc), 'config-manager.ts 残留 proxyUrl 字面（W4 P1-B 应删未删）');
    assert.ok(!enginesSrc.includes('config.proxyUrl'), 'engines 残留 config.proxyUrl 闭包接线字面（buildEngine 传参应删）');
    assert.ok(!/proxyUrl/.test(serviceSrc), 'translation-service.ts 残留 proxyUrl 字面（apply 落盘透传应删）');
    assert.ok(!configPageSrc.includes('trProxyUrl'), 'ConfigPage 残留 trProxyUrl computed（代理输入应删）');
  });

  await runCheck('EX-P8-2 行为钉：存量 proxyUrl 值在场（raw config 直建组）+ env 空 + resolveProxy DIRECT → 出站直连（哨兵零 CONNECT、loopback TLS 端点命中出译文）', async () => {
    const tlsFix = await makeTlsLoopbackServer(makeBingHandler('p8 直连译文'));
    const sentinel = await makeConnectProxy({});
    try {
      const enginesMod = loadEnginesReal({ fakeEnv: {}, electronProxyAnswer: 'DIRECT' });
      const config = {
        engines: [
          { id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${tlsFix.port}`, useProxy: true },
        ],
        // 存量 proxyUrl 值在场（raw 装载不经 sanitize——模拟字段删除前遗留值；传参删除的行为证据：
        // 若 buildEngine 仍消费该值，出站将打哨兵并被捕获）。
        proxyUrl: `http://127.0.0.1:${sentinel.port}`,
      };
      const group = (
        enginesMod as {
          createWebMtEngineGroup: (c: unknown, o?: unknown) => {
            translateSegment: (segment: string, signal: AbortSignal) => Promise<{ ok: boolean; text?: string; error?: string }>;
          };
        }
      ).createWebMtEngineGroup(config, {});
      const r = await group.translateSegment('甲'.repeat(80), new AbortController().signal);
      assert.ok(r.ok, `存量 proxyUrl 在场时直连翻译应成功：${r.error}`);
      assert.equal(r.text, 'p8 直连译文', `译文不符：${r.text}`);
      assert.equal(sentinel.connects.length, 0, `哨兵捕获 CONNECT（buildEngine 仍消费存量 proxyUrl = 回归）：${sentinel.connects.join(',')}`);
      assert.ok(tlsFix.handshakes >= 1, '直连路径未完成 TLS 握手（出站未命中 loopback 端点）');
    } finally {
      await sentinel.close();
      await tlsFix.close();
    }
  });

  await runCheck('EX-P8-3 行为钉（休眠机械活体）：resolveOutboundProxy/establishConnectTunnel/createTunnelAgent 机组可独立调用 + env HTTPS_PROXY + bing-web（useProxy=true，loopback TLS）经隧道出译文', async () => {
    const tlsFix = await makeTlsLoopbackServer(makeBingHandler('p8 隧道译文'));
    const proxy = await makeConnectProxy({ tlsUpstreamPort: tlsFix.port });
    try {
      const enginesMod = loadEnginesReal({ fakeEnv: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` }, electronProxyAnswer: 'DIRECT' });
      // 机械面独立调用（通用基建休眠但活体——「先剔除」语义下将来引擎加回即恢复消费）
      assert.equal(typeof enginesMod.resolveOutboundProxy, 'function', 'resolveOutboundProxy 未导出（机械面被删）');
      assert.equal(typeof enginesMod.establishConnectTunnel, 'function', 'establishConnectTunnel 未导出（机械面被删）');
      assert.equal(typeof enginesMod.createTunnelAgent, 'function', 'createTunnelAgent 未导出（机械面被删）');
      const resolved = await (enginesMod.resolveOutboundProxy as (useProxy: boolean) => Promise<URL | null>)(true);
      assert.ok(resolved?.href.includes(`${proxy.port}`), `env HTTPS_PROXY 解析失败：${resolved?.href}`);
      const group = (
        enginesMod as {
          createWebMtEngineGroup: (c: unknown, o?: unknown) => {
            translateSegment: (segment: string, signal: AbortSignal) => Promise<{ ok: boolean; text?: string; error?: string }>;
          };
        }
      ).createWebMtEngineGroup(
        {
          engines: [
            { id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${tlsFix.port}`, useProxy: true },
          ],
        },
        {},
      );
      const r = await group.translateSegment('甲'.repeat(80), new AbortController().signal);
      assert.ok(r.ok, `env 代理隧道翻译未成功：${r.error}`);
      assert.equal(r.text, 'p8 隧道译文', `译文不符：${r.text}`);
      // keepAlive 隧道：页面 GET 与 ttranslatev3 POST 复用同一条 env 代理隧道 socket（1 次 CONNECT）
      assert.equal(proxy.connects.length, 1, `env 代理隧道 CONNECT 计数异常：${proxy.connects.join(',')}`);
      assert.ok(tlsFix.handshakes >= 1, '隧道路径未完成 TLS 握手');
    } finally {
      await proxy.close();
      await tlsFix.close();
    }
  });

  // EX-P8-4（点指令「代理输入不存在钉」，RB-P1-P1B-T8 同面 E1 收口）：ConfigPage 代理输入整链
  // 拆除。「代理」裸字面不钉（权限模式选项「代理模式」与 web 访问「反向代理域名」为合法残留面）。
  await runCheck('EX-P8-4 代理输入不存在钉：ConfigPage 无 trProxyUrl / 代理地址 / .tr-proxy-field / proxyUrl 残留', () => {
    for (const literal of ['trProxyUrl', '代理地址', 'tr-proxy-field', 'proxyUrl'] as const) {
      assert.ok(!configPageSrc.includes(literal), `ConfigPage 代理面残留字面（p8 应删未删）：${literal}`);
    }
  });

  await runCheck('RB-MT-T36（P2-2）apply 复用最近一次探测结果：probeEngines(false) 混合结果 → 立即 probeEngines(true) 零新增引擎请求、appliedOrder 反映最近结果、落盘重排照常', async () => {
    const h = loadServiceProbe();
    // 延迟差分（T29 同款手法）：bing 即刻失败，alibaba 10ms/qq 30ms/sogou 50ms/youdao 70ms
    // → latency 升序确定性 [alibaba,qq,sogou,youdao]。
    h.setScripted((kind) => {
      if (kind === 'bing-web') return { ok: false, error: 'HTTP 503: bing down' };
      const delayMs = kind === 'alibaba-web' ? 10 : kind === 'qq-transmart' ? 30 : kind === 'sogou-web' ? 50 : 70;
      return { ok: true, text: `探@${kind}`, delayMs };
    });
    const probe1 = await (h.mod.probeEngines as (apply: boolean) => Promise<{ ok: boolean; engines: Array<{ id: string; kind: string; ok: boolean }>; appliedOrder?: string[] }>)(false);
    assert.ok(probe1.ok, '首探失败');
    assert.equal(h.calls.length, 5, `首探请求次数 ≠ 启用引擎数 5（实际 ${h.calls.length}）`);
    assert.equal(probe1.engines.filter((e) => e.ok).length, 4, '混合结果形态不符（bing 红其余绿）');
    const callsBefore = h.calls.length;
    const probe2 = await (h.mod.probeEngines as (apply: boolean) => Promise<{ ok: boolean; appliedOrder?: string[] }>)(true);
    // P2-2 本体：apply=true 且缓存新鲜（<5 分钟）→ 直接按缓存落盘、不再全量重探
    assert.equal(h.calls.length, callsBefore, `apply 探测发生新增引擎请求（复用失效 = P2-2 回归）：${h.calls.length - callsBefore} 次`);
    assert.ok(probe2.appliedOrder, 'apply 未返回 appliedOrder');
    // 跨 realm 陷阱：vm 侧数组用 join 字面比对（T29 同款）。期望 = ok 组（stable 组序 alibaba→qq→
    // sogou→youdao）+ 失败殿后 bing。
    assert.equal(
      (probe2.appliedOrder ?? []).join(','),
      'alibaba-web,qq-transmart,sogou-web,youdao-web,bing-web',
      `appliedOrder 未反映最近一次探测结果：${probe2.appliedOrder?.join(',')}`,
    );
    const patch = h.saveCalls.find((p) => 'translation' in (p as Record<string, unknown>)) as { translation?: { engines?: Array<{ id: string; order: number }> } } | undefined;
    assert.ok(patch?.translation?.engines, 'apply 未走 saveConfig 落盘');
    const orderOf = (id: string): number => patch?.translation?.engines?.find((e) => e.id === id)?.order ?? -1;
    assert.ok(orderOf('alibaba-web') === 0 && orderOf('bing-web') === 4, '落盘 order 重排与 appliedOrder 不一致');
  });

  await runCheck('RB-MT-T37（P2-2）复用窗口边界：fake clock <5min 复用（零请求）；>5min 重新全量探测（新结果落盘）', async () => {
    const h = loadServiceProbe();
    // 第一轮：bing 即刻失败、其余延迟差分 10/30/50/70ms → 复用序确定性
    h.setScripted((kind) => {
      if (kind === 'bing-web') return { ok: false, error: 'HTTP 503: bing down' };
      const delayMs = kind === 'alibaba-web' ? 10 : kind === 'qq-transmart' ? 30 : kind === 'sogou-web' ? 50 : 70;
      return { ok: true, text: `探@${kind}`, delayMs };
    });
    await (h.mod.probeEngines as (apply: boolean) => Promise<unknown>)(false);
    assert.equal(h.calls.length, 5, '首探请求次数 ≠ 5');
    // 窗口内（<5 分钟）：apply 复用缓存、零新增请求
    h.clock.offsetMs = 4 * 60_000;
    const probe2 = await (h.mod.probeEngines as (apply: boolean) => Promise<{ appliedOrder?: string[] }>)(true);
    assert.equal(h.calls.length, 5, '窗口内 apply 发生新增请求（复用窗口过短 = P2-2 回归）');
    assert.equal(
      (probe2.appliedOrder ?? []).join(','),
      'alibaba-web,qq-transmart,sogou-web,youdao-web,bing-web',
      '窗口内 appliedOrder 未复用最近一次结果',
    );
    // 推进超窗（>5 分钟）+ 换脚本（alibaba 转红、bing 转绿，延迟差分保持确定性）→ 重新全量探测、
    // 新结果落盘
    h.setScripted((kind) => {
      if (kind === 'alibaba-web') return { ok: false, error: 'HTTP 503: alibaba down' };
      const delayMs = kind === 'bing-web' ? 10 : kind === 'qq-transmart' ? 30 : kind === 'sogou-web' ? 50 : 70;
      return { ok: true, text: `探@${kind}`, delayMs };
    });
    h.clock.offsetMs = 6 * 60_000;
    const probe3 = await (h.mod.probeEngines as (apply: boolean) => Promise<{ appliedOrder?: string[] }>)(true);
    assert.equal(h.calls.length, 10, `超窗后 apply 未重新全量探测（新增 ${h.calls.length - 5} 次 ≠ 5）`);
    // 新探测（延迟差分确定性）：ok 组 = [bing(10ms),qq(30ms),sogou(50ms),youdao(70ms)]，alibaba 红殿后
    assert.equal(
      (probe3.appliedOrder ?? []).join(','),
      'bing-web,qq-transmart,sogou-web,youdao-web,alibaba-web',
      `超窗后 appliedOrder 未反映新结果：${probe3.appliedOrder?.join(',')}`,
    );
  });

  // ── E1 · loopback 行为组（round-002 C-1 修复扩容；出卷清单 §1-§5 整行 23 条 + 半面 8 条落卷） ──
  // 断言语义以 01-测试用例清单.md 对应行为行原文为准；夹具 = makeTlsLoopbackServer/makeConnectProxy
  // + httpsShim 出厂域定向重写（P1C-T4 手法，零外网出站）。bing 经 entry.endpoint 直环回（endpoint
  // 消费面本体）；alibaba/qq/sogou/youdao 经定向重写进环回（固定出厂域不消费 endpoint 的行为证据）。
  // EX-P2D 行为面两处 P2-3 修订申报（03 评审 P2-3 裁决：js 抓取仅重取链路走、happy path 零 js 下载）：
  //   ①EX-P2D-1 五步链以「重取链路触发」形态落卷（页面→js 正则→key→webtranslate→解密全链编排——
  //     happy path 无 js 步骤，五步链唯一真实形态即重取链）；
  //   ②EX-P2D-8 断言 js GET 恰 0 次（清单原文「js GET 恰 1 次」为 P2-3 前契约形态，按修订后契约转写）。
  console.log('=== E1 · bing loopback 行为组（round-002 C-1 扩容） ===');

  await runCheck('EX-P1-1c（行为半面）bing 数组形态 loopback 全链：ttranslatev3 携带 key=时间戳位/token=数组[1] + IG 查询参数（捕获比对）', async () => {
    const tlsFix = await makeTlsLoopbackServer(makeBingLoopback(bingLoopState()));
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${tlsFix.port}` }]);
      const r = await group.translateSegment('行为半面甲'.repeat(6), new AbortController().signal);
      assert.ok(r.ok, `数组形态全链应出译文：${r.error}`);
      const posts = bingPostForms(tlsFix.captured);
      assert.equal(posts.length, 1, `ttranslatev3 POST 次数异常：${posts.length}`);
      assert.equal(posts[0]?.key, '1795334774715', `ttranslatev3 key 应取数组[0] 时间戳位，实得：${posts[0]?.key}`);
      assert.notEqual(posts[0]?.key, 'key-e1-legacy', 'key 取了旧 arr[2] 位（09 §2 差异1 根因回归）');
      assert.equal(posts[0]?.token, 'tok-e1-arr', `ttranslatev3 token 应取数组[1]，实得：${posts[0]?.token}`);
      assert.equal(r.text, '行为半面甲'.repeat(6), '译文应为回显原文（全链通）');
      assert.ok((tlsFix.captured.find((c) => (c.path ?? '').startsWith('/ttranslatev3'))?.path ?? '').includes('IG=IG-E1-ARRAY'), 'IG 查询参数不在出站 URL（会话 IG 未随行）');
    } finally {
      await tlsFix.close();
    }
  });

  await runCheck('EX-P1-2b（行为半面）旧对象形态页面 loopback 全链出译文：对象 key/token 对可用（防御旧页面回滚面）', async () => {
    const st = bingLoopState();
    st.pageBody = OBJECT_PAGE;
    const tlsFix = await makeTlsLoopbackServer(makeBingLoopback(st));
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${tlsFix.port}` }]);
      const r = await group.translateSegment('对象形态乙'.repeat(6), new AbortController().signal);
      assert.ok(r.ok, `对象形态全链应出译文：${r.error}`);
      const posts = bingPostForms(tlsFix.captured);
      assert.equal(posts[0]?.key, 'key-e1-obj', `对象形态 key 未随行：${posts[0]?.key}`);
      assert.equal(posts[0]?.token, 'tok-e1-obj', `对象形态 token 未随行：${posts[0]?.token}`);
      assert.equal(r.text, '对象形态乙'.repeat(6), '对象形态译文不符');
    } finally {
      await tlsFix.close();
    }
  });

  await runCheck('EX-P1-3b（行为半面）bing 双形态缺失页面 → 引擎失败终结、组降级 alibaba 接管出译文 + 零畸形 ttranslatev3 POST 出站', async () => {
    const bingSt = bingLoopState();
    bingSt.pageBody = BARE_PAGE;
    const bingFix = await makeTlsLoopbackServer(makeBingLoopback(bingSt));
    const albFix = await makeTlsLoopbackServer(makeAlibabaLoopback(alibabaLoopState()));
    e1SetLoopbackRedirect({ 'translate.alibaba.com': albFix.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [
        { id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${bingFix.port}` },
        { id: 'alibaba-web', kind: 'alibaba-web', enabled: true, order: 1 },
      ]);
      const r = await group.translateSegment('降级接管丙'.repeat(6), new AbortController().signal);
      assert.ok(r.ok, `bing 失败后组应降级 alibaba 出译文：${r.error}`);
      assert.equal(r.text, '降级接管丙'.repeat(6), '接管译文应为 alibaba 回显');
      assert.equal([...r.tried].join(','), 'bing-web,alibaba-web', `尝试序不符（组降级面证据；跨 realm 原型陷阱——join 字面比对）：${r.tried.join(',')}`);
      assert.equal(countCaptured(bingFix.captured, '/ttranslatev3'), 0, 'bing 页面失败形态下出现 ttranslatev3 POST（畸形请求出站面）');
      assert.equal(countCaptured(albFix.captured, '/api/translate/text'), 1, 'alibaba translate POST 未恰一次命中');
    } finally {
      e1SetLoopbackRedirect({});
      await albFix.close();
      await bingFix.close();
    }
  });

  await runCheck('EX-P1-4b（行为半面）data-iid="translator.504633" → 出站 ttranslatev3 IID 参数恰含一次 translator.504633（防双拼捕获面）', async () => {
    const tlsFix = await makeTlsLoopbackServer(makeBingLoopback(bingLoopState()));
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${tlsFix.port}` }]);
      const r = await group.translateSegment('双拼面丁'.repeat(6), new AbortController().signal);
      assert.ok(r.ok, `全链应出译文：${r.error}`);
      const postPath = tlsFix.captured.find((c) => (c.path ?? '').startsWith('/ttranslatev3'))?.path ?? '';
      assert.ok(postPath.includes('IID=translator.504633'), `出站 IID 参数不在位：${postPath}`);
      assert.equal(postPath.split('translator.').length - 1, 1, `IID 前缀出现 ${postPath.split('translator.').length - 1} 次（双拼面）`);
    } finally {
      await tlsFix.close();
    }
  });

  await runCheck('EX-P1-5b（行为半面）data-iid="504633" 纯数字 → 出站 IID 恰一次 translator.504633（不二次剥捕获面）', async () => {
    const st = bingLoopState();
    st.pageBody = NUM_IID_PAGE;
    const tlsFix = await makeTlsLoopbackServer(makeBingLoopback(st));
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${tlsFix.port}` }]);
      const r = await group.translateSegment('纯数字戊'.repeat(6), new AbortController().signal);
      assert.ok(r.ok, `纯数字 IID 全链应出译文：${r.error}`);
      const postPath = tlsFix.captured.find((c) => (c.path ?? '').startsWith('/ttranslatev3'))?.path ?? '';
      assert.ok(postPath.includes('IID=translator.504633'), `出站 IID 参数不在位：${postPath}`);
      assert.equal(postPath.split('translator.').length - 1, 1, 'IID 前缀出现非一次（二次拼/误伤面）');
    } finally {
      await tlsFix.close();
    }
  });

  await runCheck('EX-P1-6b（行为半面）ttranslatev3 POST body 含 tryFetchingGenderDebiasedTranslations=true 字面（捕获面）', async () => {
    const tlsFix = await makeTlsLoopbackServer(makeBingLoopback(bingLoopState()));
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${tlsFix.port}` }]);
      const r = await group.translateSegment('payload 面'.repeat(6), new AbortController().signal);
      assert.ok(r.ok, `全链应出译文：${r.error}`);
      const posts = bingPostForms(tlsFix.captured);
      assert.equal(posts[0]?.tryFetchingGenderDebiasedTranslations, 'true', `payload 字段缺失（09 §2 差异3 捕获面）：${JSON.stringify(posts[0])}`);
    } finally {
      await tlsFix.close();
    }
  });

  await runCheck('EX-P1-8 同会话第二段：页面 GET 恰 1 次、ttranslatev3 ≥2 次（三件套会话复用——每段重抓页面 = 回归）', async () => {
    const tlsFix = await makeTlsLoopbackServer(makeBingLoopback(bingLoopState()));
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${tlsFix.port}` }]);
      const seg = '会话复用己'.repeat(6);
      const r1 = await group.translateSegment(seg, new AbortController().signal);
      const r2 = await group.translateSegment(seg + '二', new AbortController().signal);
      assert.ok(r1.ok && r2.ok, `两段翻译应成功：${r1.error ?? ''}/${r2.error ?? ''}`);
      assert.equal(countCaptured(tlsFix.captured, '/translator'), 1, `页面 GET 应恰 1 次（会话复用），实得 ${countCaptured(tlsFix.captured, '/translator')}`);
      assert.ok(countCaptured(tlsFix.captured, '/ttranslatev3') >= 2, `ttranslatev3 应 ≥2 次，实得 ${countCaptured(tlsFix.captured, '/ttranslatev3')}`);
    } finally {
      await tlsFix.close();
    }
  });

  await runCheck('EX-P1-9 token 失效重取恰一次：失效 → 页面重抓恰 1 次再试一次，重试成功出译文（页面 GET 总数=2）+ 仍失败形态不放大', async () => {
    // 子形态 A：重试成功——页面 GET 总数 2（首抓 + 恰一次重抓）、POST 总数 2
    const stA = bingLoopState();
    stA.postResponder = (n, form) => (n === 1 ? { ...BING_INVALID_REPLY } : { status: 200, body: JSON.stringify([{ translations: [{ text: form.text }] }]) });
    const fixA = await makeTlsLoopbackServer(makeBingLoopback(stA));
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${fixA.port}` }]);
      const r = await group.translateSegment('重取一次庚'.repeat(6), new AbortController().signal);
      assert.ok(r.ok, `重试应成功出译文：${r.error}`);
      assert.equal(r.text, '重取一次庚'.repeat(6), '重试成功译文不符');
      assert.equal(countCaptured(fixA.captured, '/translator'), 2, `页面 GET 总数应恰 2（首抓+重抓恰一次，不放大），实得 ${countCaptured(fixA.captured, '/translator')}`);
      assert.equal(countCaptured(fixA.captured, '/ttranslatev3'), 2, `POST 总数应恰 2（重试恰一次），实得 ${countCaptured(fixA.captured, '/ttranslatev3')}`);
    } finally {
      await fixA.close();
    }
    // 子形态 B：重试仍失效 → 引擎失败终结（组降级），重取不放大（仍 2 GET / 2 POST）
    const stB = bingLoopState();
    stB.postResponder = () => ({ ...BING_INVALID_REPLY });
    const fixB = await makeTlsLoopbackServer(makeBingLoopback(stB));
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${fixB.port}` }]);
      const r = await group.translateSegment('仍失败辛'.repeat(6), new AbortController().signal);
      assert.equal(r.ok, false, '重试仍失效应以失败形态终结（不冒充成功）');
      assert.equal(countCaptured(fixB.captured, '/translator'), 2, `失败形态页面 GET 应恰 2（不无限重试），实得 ${countCaptured(fixB.captured, '/translator')}`);
      assert.equal(countCaptured(fixB.captured, '/ttranslatev3'), 2, `失败形态 POST 应恰 2，实得 ${countCaptured(fixB.captured, '/ttranslatev3')}`);
    } finally {
      await fixB.close();
    }
  });

  await runCheck('EX-P1-10 并发单飞：两段并发同遇 token 失效 → 页面重抓恰 1 次、两段都拿到重取后结果继续（会话缓存竞态）', async () => {
    const st = bingLoopState();
    st.pageDelayMs = 20;
    // 确定性编排（round-003 flaky 修复）：失效按段标记（各段首 POST 恰失效一次、重试恒绿），不再按
    // 到达序 n 开窗——两段首 POST 与重试的到达交错不定，重试可能落进失效窗致该段二次失效、重取链跑
    // 两次（页面 GET 3 = 偶发红）。两段首 POST 到齐后同轮放行 BAD（屏障）→ 两重取尝试必然同轮发出，
    // in-flight 单飞恰合并为一次链（被测行为不变，编排确定性化）。
    const segSeen = new Set<string>();
    let openGate!: () => void;
    const gate = new Promise<void>((res) => { openGate = res; });
    let gated = false;
    setTimeout(() => { if (!gated) { gated = true; openGate(); } }, 2000).unref();
    st.postResponder = async (_n, form) => {
      const marker = typeof form.text === 'string' && form.text.includes('并发段甲') ? '甲' : typeof form.text === 'string' && form.text.includes('并发段乙') ? '乙' : '';
      if (marker && !segSeen.has(marker)) {
        segSeen.add(marker);
        if (segSeen.size >= 2 && !gated) { gated = true; openGate(); }
        await gate;
        return { ...BING_INVALID_REPLY };
      }
      return { status: 200, body: JSON.stringify([{ translations: [{ text: form.text }] }]) };
    };
    const tlsFix = await makeTlsLoopbackServer(makeBingLoopback(st));
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${tlsFix.port}` }]);
      const warm = await group.translateSegment('单飞预热'.repeat(6), new AbortController().signal);
      assert.ok(warm.ok, `预热段应成功：${warm.error}`);
      const [ra, rb] = await Promise.all([
        group.translateSegment('并发段甲'.repeat(6), new AbortController().signal),
        group.translateSegment('并发段乙'.repeat(6), new AbortController().signal),
      ]);
      assert.ok(ra.ok, `并发段甲应拿到重取后结果：${ra.error}`);
      assert.ok(rb.ok, `并发段乙应拿到重取后结果：${rb.error}`);
      assert.equal(ra.text, '并发段甲'.repeat(6), '并发段甲译文不符');
      assert.equal(rb.text, '并发段乙'.repeat(6), '并发段乙译文不符');
      assert.equal(countCaptured(tlsFix.captured, '/translator'), 2, `页面 GET 应恰 2（预热 1 + 并发重抓恰 1 次单飞），实得 ${countCaptured(tlsFix.captured, '/translator')}`);
      assert.equal(countCaptured(tlsFix.captured, '/ttranslatev3'), 5, `POST 应恰 5（预热 1 + 两段失效 2 + 重试 2），实得 ${countCaptured(tlsFix.captured, '/ttranslatev3')}`);
    } finally {
      await tlsFix.close();
    }
  });

  // r3-2-1 修复卷（2026-11-23，来源复审-r2-fixverify P3①）：bing 重取并发单飞槽 bingTokenFetch
  // 不按 host 键控——并发失效时后到者 await 共享槽拿到异 host 的会话缓存（IG/token/key/cookie 属于
  // 先发起的 host），该条目拿错会话发畸形请求。修复语义：await 后加 host 校验，异 host 者
  // 直取自身 fetchBingToken（不触碰共享槽本身，避免扰动另一 host 的 await 方）。
  // 编排确定性：两条目页面三件套值全异（IG/token/key/iid）→ POST 捕获可比对会话归属；
  // bing-a 页面 GET 加 30ms 延迟加宽 in-flight 窗，后到 bing-b 的缓存检查确定性落在共享槽未决窗口
  // （微任务链无 macrotask 边界，TLS 握手完成不可插队——同 EX-P1-10 pageDelayMs 手法）。
  await runCheck('EX-P1-10b 双 bing-web 条目异 endpoint 并发重取：两 loopback 端点（不同 host）并发触发 token 重取，各自拿到自己 host 的会话缓存（修复前红：后到者 await 共享槽混入先发起 host 的 IG/token/key，且自身页面 GET=0）', async () => {
    const pageFor = (tag: 'A' | 'B', iid: number): string =>
      `<html><script>var IG="IG-DUAL-${tag}";params_AbusePrevention=["499999999999${tag === 'A' ? '1' : '2'}","tok-dual-${tag}","key-dual-${tag}",0,1]</script><div id="tta_outGDCont" data-iid="translator.${iid}"></div>ok</html>`;
    const stA = bingLoopState();
    stA.pageBody = pageFor('A', 5031);
    stA.pageDelayMs = 30;
    const stB = bingLoopState();
    stB.pageBody = pageFor('B', 5032);
    const fixA = await makeTlsLoopbackServer(makeBingLoopback(stA));
    const fixB = await makeTlsLoopbackServer(makeBingLoopback(stB));
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [
        { id: 'bing-a', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${fixA.port}` },
        { id: 'bing-b', kind: 'bing-web', enabled: true, order: 1, endpoint: `127.0.0.1:${fixB.port}` },
      ]);
      // 并发两段：段甲走 order-0 bing-a（首引擎），段乙粘性起点钉 bing-b（异 host 条目）。
      const [ra, rb] = await Promise.all([
        group.translateSegment('异端并发甲'.repeat(6), new AbortController().signal),
        group.translateSegment('异端并发乙'.repeat(6), new AbortController().signal, 'bing-b'),
      ]);
      assert.ok(ra.ok, `bing-a 段应成功：${ra.error}`);
      assert.ok(rb.ok, `bing-b 段应成功：${rb.error}`);
      assert.equal(ra.text, '异端并发甲'.repeat(6), 'bing-a 段译文不符');
      assert.equal(rb.text, '异端并发乙'.repeat(6), 'bing-b 段译文不符');
      // bing-b 侧主面①：自身 host 页面 GET 恰 1（修复前到者 await 共享槽不取自身页面，实得 0）
      assert.equal(
        countCaptured(fixB.captured, '/translator'),
        1,
        `bing-b 页面 GET 应恰 1（自身 host 重取发生；修复前 await 共享槽实得 0），实得 ${countCaptured(fixB.captured, '/translator')}`,
      );
      // bing-b 侧主面②：POST 会话三件套 = 自己 host 页面值（修复前 = bing-a 的 tok/key/IG）
      const formsB = bingPostForms(fixB.captured);
      assert.equal(formsB.length, 1, `bing-b 侧 POST 应恰 1（段乙单段单 POST），实得 ${formsB.length}`);
      assert.equal(formsB[0]?.token, 'tok-dual-B', `bing-b POST token 应为自己 host 的 tok-dual-B（修复前混入先发起 host 会话 tok-dual-A），实得 ${formsB[0]?.token}`);
      // key=arr[0] 时间戳位（09 §2 差异1：String(arr[0])，arr[2] 不消费）——A/B 页面时间戳位互异可比对归属
      assert.equal(formsB[0]?.key, '4999999999992', `bing-b POST key 应为自己 host 页面 arr[0] 时间戳位（修复前混入 bing-a 的 4999999999991），实得 ${formsB[0]?.key}`);
      const igB = new URLSearchParams(fixB.captured.find((c) => (c.path ?? '').startsWith('/ttranslatev3'))?.path ?? '').get('IG');
      assert.equal(igB, 'IG-DUAL-B', `bing-b POST IG 应为自己 host 的 IG-DUAL-B（修复前混入 IG-DUAL-A），实得 ${igB}`);
      // bing-a 侧对照面：POST 会话三件套 = 自己 host 页面值（未被另一 host 重取覆写污染）
      const formsA = bingPostForms(fixA.captured);
      assert.equal(formsA.length, 1, `bing-a 侧 POST 应恰 1（段甲单段单 POST），实得 ${formsA.length}`);
      assert.equal(formsA[0]?.token, 'tok-dual-A', `bing-a POST token 应为自己 host 的 tok-dual-A，实得 ${formsA[0]?.token}`);
      assert.equal(formsA[0]?.key, '4999999999991', `bing-a POST key 应为自己 host 页面 arr[0] 时间戳位，实得 ${formsA[0]?.key}`);
      // 段归属不串台：两段文本各自只出现在自己 host 的 POST 面
      assert.equal(formsA[0]?.text, '异端并发甲'.repeat(6), 'bing-a 侧 POST 文本不符（段甲串台）');
      assert.equal(formsB[0]?.text, '异端并发乙'.repeat(6), 'bing-b 侧 POST 文本不符（段乙串台）');
    } finally {
      await fixA.close();
      await fixB.close();
    }
  });

  await runCheck('EX-P1-11 probe bing 429 恰重试一次判定：重试成功=ok 行（latency 在）；仍 429=红行（error 含 429）；重试次数=1 不放大', async () => {
    // 子形态 A：首 POST 429、重试成功 → 探测行 ok=true
    const stA = bingLoopState();
    stA.postResponder = (n, form) => (n === 1 ? { status: 429, body: '{"ShowCaptcha":false}' } : { status: 200, body: JSON.stringify([{ translations: [{ text: form.text }] }]) });
    const fixA = await makeTlsLoopbackServer(makeBingLoopback(stA));
    try {
      const h = loadServiceProbeReal([{ id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${fixA.port}` }]);
      const result = await (h.mod.probeEngines as (apply: boolean) => Promise<{ ok: boolean; engines: Array<{ id: string; kind: string; ok: boolean; latencyMs: number; error?: string }> }>)(false);
      const row = result.engines.find((e) => e.kind === 'bing-web');
      assert.ok(row, '探测结果缺 bing 行');
      assert.equal(row.ok, true, `429 重试成功后探测行应为 ok：${row.error}`);
      assert.equal(typeof row.latencyMs, 'number', 'ok 行缺 latency（latency 在面）');
      assert.equal(countCaptured(fixA.captured, '/ttranslatev3'), 2, `429 重试 POST 应恰 2（恰重试 1 次不放大），实得 ${countCaptured(fixA.captured, '/ttranslatev3')}`);
      assert.equal(countCaptured(fixA.captured, '/translator'), 2, `页面 GET 应恰 2（重抓恰一次），实得 ${countCaptured(fixA.captured, '/translator')}`);
    } finally {
      await fixA.close();
    }
    // 子形态 B：恒 429 → 恰重试 1 次后判定红行（error 含 429）
    const stB = bingLoopState();
    stB.postResponder = () => ({ status: 429, body: '{"ShowCaptcha":false}' });
    const fixB = await makeTlsLoopbackServer(makeBingLoopback(stB));
    try {
      const h = loadServiceProbeReal([{ id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${fixB.port}` }]);
      const result = await (h.mod.probeEngines as (apply: boolean) => Promise<{ ok: boolean; engines: Array<{ id: string; kind: string; ok: boolean; latencyMs: number; error?: string }> }>)(false);
      const row = result.engines.find((e) => e.kind === 'bing-web');
      assert.ok(row, '探测结果缺 bing 行');
      assert.equal(row.ok, false, '恒 429 应判红行（不冒充成功）');
      assert.ok((row.error ?? '').includes('429'), `红行 error 应含 429 字样：${row.error}`);
      assert.equal(countCaptured(fixB.captured, '/ttranslatev3'), 2, `恒 429 POST 应恰 2（重试恰一次不放大），实得 ${countCaptured(fixB.captured, '/ttranslatev3')}`);
    } finally {
      await fixB.close();
    }
  });

  console.log('=== E1 · alibaba loopback 行为组（round-002 C-1 扩容） ===');

  await runCheck('EX-P2A-1 三步链全链编排：预热→csrf→multipart POST → 译文 = data.translateText 且恰一次 translate POST（csrf 头面双携带）', async () => {
    const tlsFix = await makeTlsLoopbackServer(makeAlibabaLoopback(alibabaLoopState()));
    e1SetLoopbackRedirect({ 'translate.alibaba.com': tlsFix.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'alibaba-web', kind: 'alibaba-web', enabled: true, order: 0 }]);
      const r = await group.translateSegment('三步链甲'.repeat(6), new AbortController().signal);
      assert.ok(r.ok, `三步链应出译文：${r.error}`);
      assert.equal(r.text, '三步链甲'.repeat(6), '译文应为 data.translateText 回显');
      assert.equal(countCaptured(tlsFix.captured, '/api/translate/text'), 1, `translate POST 应恰 1 次，实得 ${countCaptured(tlsFix.captured, '/api/translate/text')}`);
      const post = tlsFix.captured.find((c) => (c.path ?? '').startsWith('/api/translate/text'));
      assert.ok(post?.headers['x-csrf-token'] === 'tok-e1-csrf', `csrf 头面未随行（headerName 动态携带面）：${String(post?.headers['x-csrf-token'])}`);
      assert.ok((post?.headers['content-type'] ?? '').startsWith('multipart/form-data; boundary='), 'translate POST Content-Type 应为 multipart 带边界');
    } finally {
      e1SetLoopbackRedirect({});
      await tlsFix.close();
    }
  });

  await runCheck('EX-P2A-3 csrf 端点 500 → 引擎以失败形态终结、组降级 qq-transmart 接管出译文 + 零畸形 translate POST 出站', async () => {
    const albSt = alibabaLoopState();
    albSt.csrfResponder = () => ({ status: 500, body: 'boom' });
    const albFix = await makeTlsLoopbackServer(makeAlibabaLoopback(albSt));
    const qqFix = await makeTlsLoopbackServer(makeQqLoopback(qqLoopState()));
    e1SetLoopbackRedirect({ 'translate.alibaba.com': albFix.port, 'transmart.qq.com': qqFix.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [
        { id: 'alibaba-web', kind: 'alibaba-web', enabled: true, order: 0 },
        { id: 'qq-transmart', kind: 'qq-transmart', enabled: true, order: 1 },
      ]);
      const r = await group.translateSegment('csrf 五百'.repeat(6), new AbortController().signal);
      assert.ok(r.ok, `csrf 500 后组应降级 qq 接管：${r.error}`);
      assert.equal(r.text, 'csrf 五百'.repeat(6), '接管译文应为 qq 回显');
      assert.equal([...r.tried].join(','), 'alibaba-web,qq-transmart', `尝试序不符（跨 realm 原型陷阱——join 字面比对）：${r.tried.join(',')}`);
      assert.equal(countCaptured(albFix.captured, '/api/translate/text'), 0, 'csrf 500 形态下出现 translate POST（畸形请求出站面）');
      assert.equal(countCaptured(qqFix.captured, '/api/imt'), 2, 'qq 接管链 imt POST 应恰 2（分句+翻译）');
    } finally {
      e1SetLoopbackRedirect({});
      await qqFix.close();
      await albFix.close();
    }
  });

  await runCheck('EX-P2A-4 translate 响应 success:false → 失败形态终结、组降级（translate POST 恰 2 = 一次重取不放大）', async () => {
    const albSt = alibabaLoopState();
    albSt.translateResponder = () => ({ status: 200, body: JSON.stringify({ success: false, data: {} }) });
    const albFix = await makeTlsLoopbackServer(makeAlibabaLoopback(albSt));
    const qqFix = await makeTlsLoopbackServer(makeQqLoopback(qqLoopState()));
    e1SetLoopbackRedirect({ 'translate.alibaba.com': albFix.port, 'transmart.qq.com': qqFix.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [
        { id: 'alibaba-web', kind: 'alibaba-web', enabled: true, order: 0 },
        { id: 'qq-transmart', kind: 'qq-transmart', enabled: true, order: 1 },
      ]);
      const r = await group.translateSegment('success 假'.repeat(6), new AbortController().signal);
      assert.ok(r.ok, `success:false 后组应降级：${r.error}`);
      assert.equal(r.text, 'success 假'.repeat(6), '接管译文不符');
      assert.equal(countCaptured(albFix.captured, '/api/translate/text'), 2, `alibaba POST 应恰 2（失败重取恰一次不放大），实得 ${countCaptured(albFix.captured, '/api/translate/text')}`);
    } finally {
      e1SetLoopbackRedirect({});
      await qqFix.close();
      await albFix.close();
    }
  });

  await runCheck('EX-P2A-5 csrf 会话级缓存恰 1 次：同会话第二段预热 GET 与 csrftoken GET 各恰 1 次、translate POST ≥2 次', async () => {
    const tlsFix = await makeTlsLoopbackServer(makeAlibabaLoopback(alibabaLoopState()));
    e1SetLoopbackRedirect({ 'translate.alibaba.com': tlsFix.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'alibaba-web', kind: 'alibaba-web', enabled: true, order: 0 }]);
      const r1 = await group.translateSegment('csrf 缓存甲'.repeat(6), new AbortController().signal);
      const r2 = await group.translateSegment('csrf 缓存乙'.repeat(6), new AbortController().signal);
      assert.ok(r1.ok && r2.ok, `两段应成功：${r1.error ?? ''}/${r2.error ?? ''}`);
      assert.equal(countCaptured(tlsFix.captured, '/api/translate/csrftoken'), 1, `csrftoken GET 应恰 1 次，实得 ${countCaptured(tlsFix.captured, '/api/translate/csrftoken')}`);
      assert.equal(countCapturedExact(tlsFix.captured, '/'), 1, `预热页 GET 应恰 1 次，实得 ${countCapturedExact(tlsFix.captured, '/')}`);
      assert.ok(countCaptured(tlsFix.captured, '/api/translate/text') >= 2, 'translate POST 应 ≥2 次');
    } finally {
      e1SetLoopbackRedirect({});
      await tlsFix.close();
    }
  });

  await runCheck('EX-P2A-6 失败重取恰一次：translate 失效 → csrf 重取恰 1 次 → 重试成功出译文；csrftoken GET 总数=2；仍失败形态不放大', async () => {
    // 子形态 A：重试成功
    const stA = alibabaLoopState();
    stA.translateResponder = (n, query) => (n === 1
      ? { status: 200, body: JSON.stringify({ success: false, data: {} }) }
      : { status: 200, body: JSON.stringify({ success: true, data: { translateText: query } }) });
    const fixA = await makeTlsLoopbackServer(makeAlibabaLoopback(stA));
    e1SetLoopbackRedirect({ 'translate.alibaba.com': fixA.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'alibaba-web', kind: 'alibaba-web', enabled: true, order: 0 }]);
      const r = await group.translateSegment('重取一次甲'.repeat(6), new AbortController().signal);
      assert.ok(r.ok, `csrf 重取后重试应成功：${r.error}`);
      assert.equal(r.text, '重取一次甲'.repeat(6), '重试译文不符');
      assert.equal(countCaptured(fixA.captured, '/api/translate/csrftoken'), 2, `csrftoken GET 总数应恰 2（重取恰一次），实得 ${countCaptured(fixA.captured, '/api/translate/csrftoken')}`);
      assert.equal(countCaptured(fixA.captured, '/api/translate/text'), 2, 'translate POST 应恰 2（失效 1 + 重试 1）');
    } finally {
      e1SetLoopbackRedirect({});
      await fixA.close();
    }
    // 子形态 B：重试仍失效 → 失败终结、csrf GET 不放大
    const stB = alibabaLoopState();
    stB.translateResponder = () => ({ status: 200, body: JSON.stringify({ success: false, data: {} }) });
    const fixB = await makeTlsLoopbackServer(makeAlibabaLoopback(stB));
    e1SetLoopbackRedirect({ 'translate.alibaba.com': fixB.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'alibaba-web', kind: 'alibaba-web', enabled: true, order: 0 }]);
      const r = await group.translateSegment('仍失效乙'.repeat(6), new AbortController().signal);
      assert.equal(r.ok, false, '重试仍失效应以失败形态终结');
      assert.equal(countCaptured(fixB.captured, '/api/translate/csrftoken'), 2, `失败形态 csrftoken GET 应恰 2（不放大），实得 ${countCaptured(fixB.captured, '/api/translate/csrftoken')}`);
    } finally {
      e1SetLoopbackRedirect({});
      await fixB.close();
    }
  });

  await runCheck('EX-P2A-7 并发单飞：两段并发同遇失效 csrf → csrf GET 重取恰 1 次、两段都继续（不双取、不互踩出两份 csrf）', async () => {
    const st = alibabaLoopState();
    st.csrfDelayMs = 20;
    // 确定性编排（round-003 flaky 修复，EX-P1-10 同款）：失效按段标记（各段首 POST 恰失效一次、重试
    // 恒绿）+ 两段首 POST 到齐后同轮放行 BAD（屏障）→ 两 csrf 重取尝试必然同轮发出 → 单飞恰合并一链。
    const segSeen = new Set<string>();
    let openGate!: () => void;
    const gate = new Promise<void>((res) => { openGate = res; });
    let gated = false;
    setTimeout(() => { if (!gated) { gated = true; openGate(); } }, 2000).unref();
    st.translateResponder = async (_n, query) => {
      const marker = query.includes('并发甲') ? '甲' : query.includes('并发乙') ? '乙' : '';
      if (marker && !segSeen.has(marker)) {
        segSeen.add(marker);
        if (segSeen.size >= 2 && !gated) { gated = true; openGate(); }
        await gate;
        return { status: 200, body: JSON.stringify({ success: false, data: {} }) };
      }
      return { status: 200, body: JSON.stringify({ success: true, data: { translateText: query } }) };
    };
    const tlsFix = await makeTlsLoopbackServer(makeAlibabaLoopback(st));
    e1SetLoopbackRedirect({ 'translate.alibaba.com': tlsFix.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'alibaba-web', kind: 'alibaba-web', enabled: true, order: 0 }]);
      const warm = await group.translateSegment('单飞预热'.repeat(6), new AbortController().signal);
      assert.ok(warm.ok, `预热段应成功：${warm.error}`);
      const [ra, rb] = await Promise.all([
        group.translateSegment('并发甲'.repeat(6), new AbortController().signal),
        group.translateSegment('并发乙'.repeat(6), new AbortController().signal),
      ]);
      assert.ok(ra.ok, `并发段甲应继续：${ra.error}`);
      assert.ok(rb.ok, `并发段乙应继续：${rb.error}`);
      assert.equal(ra.text, '并发甲'.repeat(6), '并发段甲译文不符');
      assert.equal(rb.text, '并发乙'.repeat(6), '并发段乙译文不符');
      assert.equal(countCaptured(tlsFix.captured, '/api/translate/csrftoken'), 2, `csrftoken GET 应恰 2（预热 1 + 重取恰 1 次单飞），实得 ${countCaptured(tlsFix.captured, '/api/translate/csrftoken')}`);
      assert.equal(countCapturedExact(tlsFix.captured, '/'), 2, `预热页 GET 应恰 2（预热 1 + 重取链 1），实得 ${countCapturedExact(tlsFix.captured, '/')}`);
    } finally {
      e1SetLoopbackRedirect({});
      await tlsFix.close();
    }
  });

  await runCheck('EX-P2A-8 >5000 句末子切行为面：恰 5000 字符单请求不切；5001 字符句末子切、子段各自 POST、译文按序拼接逐字保全', async () => {
    const tlsFix = await makeTlsLoopbackServer(makeAlibabaLoopback(alibabaLoopState()));
    e1SetLoopbackRedirect({ 'translate.alibaba.com': tlsFix.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'alibaba-web', kind: 'alibaba-web', enabled: true, order: 0 }]);
      // 恰 5000：5 句 × 1000 字符（句末 '.'）→ 单请求不切
      const seg5000 = `${'a'.repeat(999)}.`.repeat(5);
      assert.equal(seg5000.length, 5000, '前置失败：夹具段长非 5000');
      const r1 = await group.translateSegment(seg5000, new AbortController().signal);
      assert.ok(r1.ok, `恰 5000 段应成功：${r1.error}`);
      assert.equal(r1.text, seg5000, '恰 5000 段译文逐字不符');
      assert.equal(countCaptured(tlsFix.captured, '/api/translate/text'), 1, '恰 5000 段应单请求不切（POST=1）');
      // 5001：末尾 +1 无句末字符 → 句末子切成 [5000, 1] 两请求
      const seg5001 = `${seg5000}b`;
      const r2 = await group.translateSegment(seg5001, new AbortController().signal);
      assert.ok(r2.ok, `5001 段应成功：${r2.error}`);
      assert.equal(r2.text, seg5001, '5001 段译文按序拼接逐字保全不符');
      const posts = tlsFix.captured.filter((c) => (c.path ?? '').startsWith('/api/translate/text'));
      assert.equal(posts.length, 3, `5001 段应句末子切为 2 POST（总 POST=1+2=3），实得 ${posts.length}`);
      assert.equal(multipartFieldValue(posts[1]?.body ?? '', 'query').length, 5000, '子段 1 应为句末切出的 5000 字符');
      assert.equal(multipartFieldValue(posts[2]?.body ?? '', 'query'), 'b', '子段 2 应为残余 1 字符');
    } finally {
      e1SetLoopbackRedirect({});
      await tlsFix.close();
    }
  });

  await runCheck('EX-P2A-9 endpoint 脏值出站不消费：alibaba 条目带 endpoint 脏值 → 出站仍恒出厂域 translate.alibaba.com（定向重写命中、脏主机零出站）', async () => {
    const tlsFix = await makeTlsLoopbackServer(makeAlibabaLoopback(alibabaLoopState()));
    e1SetLoopbackRedirect({ 'translate.alibaba.com': tlsFix.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'alibaba-web', kind: 'alibaba-web', enabled: true, order: 0, endpoint: 'dirty-e1.invalid' }]);
      const r = await group.translateSegment('脏值不消费'.repeat(6), new AbortController().signal);
      assert.ok(r.ok, `endpoint 脏值不应影响出站（适配器消费 endpoint = 回归）：${r.error}`);
      assert.equal(r.text, '脏值不消费'.repeat(6), '译文不符');
      assert.ok((e1LoopbackRedirectState.hits.get('translate.alibaba.com') ?? 0) >= 1, '出站未命中出厂域 translate.alibaba.com（定向重写未触发 = 出站目标漂移）');
      assert.ok(!e1LoopbackRedirectState.seen.has('dirty-e1.invalid'), '出站请求打到 endpoint 脏值主机（P1-5 违约行为证据）');
      assert.deepEqual([...e1LoopbackRedirectState.seen].filter((h) => h !== '127.0.0.1'), ['translate.alibaba.com'], `出站主机集漂移：${[...e1LoopbackRedirectState.seen].join(',')}`);
    } finally {
      e1SetLoopbackRedirect({});
      await tlsFix.close();
    }
  });

  console.log('=== E1 · qq-transmart loopback 行为组（round-002 C-1 扩容） ===');

  await runCheck('EX-P2B-1 三步链编排：预热 → text_analysis 分句 → auto_translation → 译文 = 去首尾空串拼接（loopback 出译文）', async () => {
    const tlsFix = await makeTlsLoopbackServer(makeQqLoopback(qqLoopState()));
    e1SetLoopbackRedirect({ 'transmart.qq.com': tlsFix.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'qq-transmart', kind: 'qq-transmart', enabled: true, order: 0 }]);
      const r = await group.translateSegment('qq 三步链'.repeat(6), new AbortController().signal);
      assert.ok(r.ok, `三步链应出译文：${r.error}`);
      assert.equal(r.text, 'qq 三步链'.repeat(6), '译文应为 auto_translation 去首尾空串拼接（恒等回显）');
      const imtPosts = tlsFix.captured.filter((c) => (c.path ?? '').startsWith('/api/imt'));
      assert.equal(imtPosts.length, 2, `imt POST 应恰 2（text_analysis + auto_translation），实得 ${imtPosts.length}`);
      const fns = imtPosts.map((c) => String((JSON.parse(c.body) as { header?: { fn?: string } }).header?.fn));
      assert.deepEqual(fns, ['text_analysis', 'auto_translation'], `imt 调用序不符：${fns.join(',')}`);
    } finally {
      e1SetLoopbackRedirect({});
      await tlsFix.close();
    }
  });

  await runCheck('EX-P2B-8 client_key 会话复用：同会话第二次翻译两次请求 Cookie client_key 字面相同、预热不重复（uuid 每会话一个）', async () => {
    const tlsFix = await makeTlsLoopbackServer(makeQqLoopback(qqLoopState()));
    e1SetLoopbackRedirect({ 'transmart.qq.com': tlsFix.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'qq-transmart', kind: 'qq-transmart', enabled: true, order: 0 }]);
      const r1 = await group.translateSegment('会话复用甲'.repeat(6), new AbortController().signal);
      const r2 = await group.translateSegment('会话复用乙'.repeat(6), new AbortController().signal);
      assert.ok(r1.ok && r2.ok, `两段应成功：${r1.error ?? ''}/${r2.error ?? ''}`);
      assert.equal(countCapturedExact(tlsFix.captured, '/'), 1, `预热应恰 1 次（不重复预热），实得 ${countCapturedExact(tlsFix.captured, '/')}`);
      const keys = tlsFix.captured
        .filter((c) => (c.path ?? '').startsWith('/api/imt'))
        .map((c) => /client_key=([^;]+)/.exec(c.headers.cookie ?? '')?.[1] ?? '');
      assert.equal(keys.length, 4, `imt 请求应恰 4（两段 × 分句+翻译），实得 ${keys.length}`);
      assert.ok(keys.every((k) => k.length > 0), 'Cookie 缺 client_key（会话主体未随行）');
      assert.ok(keys.every((k) => k === keys[0]), `client_key 每请求漂移（uuid 应每会话一个）：${keys.join(' | ')}`);
    } finally {
      e1SetLoopbackRedirect({});
      await tlsFix.close();
    }
  });

  await runCheck('EX-P2B-9 会话预热并发单飞：两段并发预热恰 1 次、两请求 Cookie client_key 一致', async () => {
    const st = qqLoopState();
    st.pageDelayMs = 20;
    const tlsFix = await makeTlsLoopbackServer(makeQqLoopback(st));
    e1SetLoopbackRedirect({ 'transmart.qq.com': tlsFix.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'qq-transmart', kind: 'qq-transmart', enabled: true, order: 0 }]);
      const [ra, rb] = await Promise.all([
        group.translateSegment('并发甲'.repeat(6), new AbortController().signal),
        group.translateSegment('并发乙'.repeat(6), new AbortController().signal),
      ]);
      assert.ok(ra.ok, `并发段甲应成功：${ra.error}`);
      assert.ok(rb.ok, `并发段乙应成功：${rb.error}`);
      assert.equal(countCapturedExact(tlsFix.captured, '/'), 1, `预热应恰 1 次（并发单飞），实得 ${countCapturedExact(tlsFix.captured, '/')}`);
      const keys = tlsFix.captured
        .filter((c) => (c.path ?? '').startsWith('/api/imt'))
        .map((c) => /client_key=([^;]+)/.exec(c.headers.cookie ?? '')?.[1] ?? '');
      assert.ok(keys.length >= 4 && keys.every((k) => k === keys[0]), `并发 client_key 应一致（单飞不漂移）：${keys.join(' | ')}`);
    } finally {
      e1SetLoopbackRedirect({});
      await tlsFix.close();
    }
  });

  await runCheck('EX-P2B-10 endpoint 脏值出站不消费：qq 条目带 endpoint 脏值 → 出站仍恒出厂域 transmart.qq.com', async () => {
    const tlsFix = await makeTlsLoopbackServer(makeQqLoopback(qqLoopState()));
    e1SetLoopbackRedirect({ 'transmart.qq.com': tlsFix.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'qq-transmart', kind: 'qq-transmart', enabled: true, order: 0, endpoint: 'dirty-e1.invalid' }]);
      const r = await group.translateSegment('脏值不消费'.repeat(6), new AbortController().signal);
      assert.ok(r.ok, `endpoint 脏值不应影响出站：${r.error}`);
      assert.ok((e1LoopbackRedirectState.hits.get('transmart.qq.com') ?? 0) >= 1, '出站未命中出厂域 transmart.qq.com');
      assert.ok(!e1LoopbackRedirectState.seen.has('dirty-e1.invalid'), '出站请求打到 endpoint 脏值主机（P1-5 违约行为证据）');
    } finally {
      e1SetLoopbackRedirect({});
      await tlsFix.close();
    }
  });

  console.log('=== E1 · sogou-web loopback 行为组（round-002 C-1 扩容） ===');

  await runCheck('EX-P2C-1 两步链编排：/text 预热 → result POST → 译文 = data.translate.dit（loopback 出译文）', async () => {
    const tlsFix = await makeTlsLoopbackServer(makeSogouLoopback(sogouLoopState()));
    e1SetLoopbackRedirect({ 'fanyi.sogou.com': tlsFix.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'sogou-web', kind: 'sogou-web', enabled: true, order: 0 }]);
      const r = await group.translateSegment('sogou 两步链'.repeat(6), new AbortController().signal);
      assert.ok(r.ok, `两步链应出译文：${r.error}`);
      assert.equal(r.text, 'sogou 两步链'.repeat(6), '译文应为 data.translate.dit 回显');
      assert.equal(countCaptured(tlsFix.captured, '/api/transpc/text/result'), 1, `result POST 应恰 1 次，实得 ${countCaptured(tlsFix.captured, '/api/transpc/text/result')}`);
    } finally {
      e1SetLoopbackRedirect({});
      await tlsFix.close();
    }
  });

  await runCheck('EX-P2C-7 预热 cookie 会话级：同会话第二段 /text GET 恰 1 次、result POST ≥2 次（每段重预热 = 回归）', async () => {
    const tlsFix = await makeTlsLoopbackServer(makeSogouLoopback(sogouLoopState()));
    e1SetLoopbackRedirect({ 'fanyi.sogou.com': tlsFix.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'sogou-web', kind: 'sogou-web', enabled: true, order: 0 }]);
      const r1 = await group.translateSegment('预热复用甲'.repeat(6), new AbortController().signal);
      const r2 = await group.translateSegment('预热复用乙'.repeat(6), new AbortController().signal);
      assert.ok(r1.ok && r2.ok, `两段应成功：${r1.error ?? ''}/${r2.error ?? ''}`);
      assert.equal(countCaptured(tlsFix.captured, '/text'), 1, `/text GET 应恰 1 次，实得 ${countCaptured(tlsFix.captured, '/text')}`);
      assert.ok(countCaptured(tlsFix.captured, '/api/transpc/text/result') >= 2, 'result POST 应 ≥2 次');
    } finally {
      e1SetLoopbackRedirect({});
      await tlsFix.close();
    }
  });

  await runCheck('EX-P2C-8 会话级 uuid 并发一致：两段并发 uuid 一致、预热恰 1 次', async () => {
    const st = sogouLoopState();
    st.pageDelayMs = 20;
    const tlsFix = await makeTlsLoopbackServer(makeSogouLoopback(st));
    e1SetLoopbackRedirect({ 'fanyi.sogou.com': tlsFix.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'sogou-web', kind: 'sogou-web', enabled: true, order: 0 }]);
      const [ra, rb] = await Promise.all([
        group.translateSegment('并发甲'.repeat(6), new AbortController().signal),
        group.translateSegment('并发乙'.repeat(6), new AbortController().signal),
      ]);
      assert.ok(ra.ok, `并发段甲应成功：${ra.error}`);
      assert.ok(rb.ok, `并发段乙应成功：${rb.error}`);
      assert.equal(countCaptured(tlsFix.captured, '/text'), 1, `预热应恰 1 次（并发单飞），实得 ${countCaptured(tlsFix.captured, '/text')}`);
      const uuids = tlsFix.captured
        .filter((c) => (c.path ?? '').startsWith('/api/transpc/text/result'))
        .map((c) => Object.fromEntries(new URLSearchParams(c.body)).uuid ?? '');
      assert.equal(uuids.length, 2, `result POST 应恰 2，实得 ${uuids.length}`);
      assert.ok(uuids.every((u) => u.length > 0), 'form 缺 uuid');
      assert.equal(uuids[0], uuids[1], `会话级 uuid 并发漂移：${uuids.join(' | ')}`);
    } finally {
      e1SetLoopbackRedirect({});
      await tlsFix.close();
    }
  });

  await runCheck('EX-P2C-9 endpoint 脏值出站不消费：sogou 条目带 endpoint 脏值 → 出站仍恒出厂域 fanyi.sogou.com', async () => {
    const tlsFix = await makeTlsLoopbackServer(makeSogouLoopback(sogouLoopState()));
    e1SetLoopbackRedirect({ 'fanyi.sogou.com': tlsFix.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'sogou-web', kind: 'sogou-web', enabled: true, order: 0, endpoint: 'dirty-e1.invalid' }]);
      const r = await group.translateSegment('脏值不消费'.repeat(6), new AbortController().signal);
      assert.ok(r.ok, `endpoint 脏值不应影响出站：${r.error}`);
      assert.ok((e1LoopbackRedirectState.hits.get('fanyi.sogou.com') ?? 0) >= 1, '出站未命中出厂域 fanyi.sogou.com');
      assert.ok(!e1LoopbackRedirectState.seen.has('dirty-e1.invalid'), '出站请求打到 endpoint 脏值主机（P1-5 违约行为证据）');
    } finally {
      e1SetLoopbackRedirect({});
      await tlsFix.close();
    }
  });

  console.log('=== E1 · youdao-web V2 loopback 行为组（round-002 C-1 扩容） ===');

  await runCheck('EX-P2D-1 五步全链编排（P2-3 修订形态：重取链触发 js 步）：页面→js 正则→key→webtranslate→解密 → 译文 = translateResult[].tgt 拼接', async () => {
    const st = youdaoLoopState();
    st.webResponder = (n, form) => (n === 1
      ? { status: 200, body: YOUDAO_BAD_CIPHER }
      : { status: 200, body: youdaoEncrypt(JSON.stringify({ translateResult: [[{ tgt: form.i }]] }), 'e1-aes-key', 'e1-aes-iv') });
    const tlsFix = await makeTlsLoopbackServer(makeYoudaoLoopback(st));
    e1SetLoopbackRedirect({ 'fanyi.youdao.com': tlsFix.port, 'dict.youdao.com': tlsFix.port, 'shared.ydstatic.com': tlsFix.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'youdao-web', kind: 'youdao-web', enabled: true, order: 0 }]);
      const r = await group.translateSegment('五步链甲'.repeat(6), new AbortController().signal);
      assert.ok(r.ok, `五步链应出译文：${r.error}`);
      assert.equal(r.text, '五步链甲'.repeat(6), '译文应为解密后 tgt 拼接回显');
      assert.equal(countCapturedExact(tlsFix.captured, '/webtranslate'), 2, `webtranslate POST 应恰 2（失效 1 + 重试 1），实得 ${countCapturedExact(tlsFix.captured, '/webtranslate')}`);
      assert.ok(countCaptured(tlsFix.captured, '/dict/translation-website/') >= 1, 'js 步骤未发生（五步链 js 步缺失）');
      assert.equal(countCaptured(tlsFix.captured, '/webtranslate/key'), 2, `key 步骤应恰 2（冷启 1 + 重取 1），实得 ${countCaptured(tlsFix.captured, '/webtranslate/key')}`);
    } finally {
      e1SetLoopbackRedirect({});
      await tlsFix.close();
    }
  });

  await runCheck('EX-P2D-8 三件套会话缓存恰 1 次（P2-3 修订形态：happy path 零 js）：同会话第二段页面/key GET 各恰 1 次、js GET 恰 0 次、webtranslate POST ≥2', async () => {
    const tlsFix = await makeTlsLoopbackServer(makeYoudaoLoopback(youdaoLoopState()));
    e1SetLoopbackRedirect({ 'fanyi.youdao.com': tlsFix.port, 'dict.youdao.com': tlsFix.port, 'shared.ydstatic.com': tlsFix.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'youdao-web', kind: 'youdao-web', enabled: true, order: 0 }]);
      const r1 = await group.translateSegment('密钥复用甲'.repeat(6), new AbortController().signal);
      const r2 = await group.translateSegment('密钥复用乙'.repeat(6), new AbortController().signal);
      assert.ok(r1.ok && r2.ok, `两段应成功：${r1.error ?? ''}/${r2.error ?? ''}`);
      assert.equal(countCapturedExact(tlsFix.captured, '/'), 1, `页面 GET 应恰 1 次，实得 ${countCapturedExact(tlsFix.captured, '/')}`);
      assert.equal(countCaptured(tlsFix.captured, '/webtranslate/key'), 1, `key GET 应恰 1 次（密钥会话缓存），实得 ${countCaptured(tlsFix.captured, '/webtranslate/key')}`);
      assert.equal(countCaptured(tlsFix.captured, '/dict/translation-website/'), 0, `happy path js GET 应恰 0 次（P2-3 零 js 下载），实得 ${countCaptured(tlsFix.captured, '/dict/translation-website/')}`);
      assert.ok(countCapturedExact(tlsFix.captured, '/webtranslate') >= 2, 'webtranslate POST 应 ≥2 次');
    } finally {
      e1SetLoopbackRedirect({});
      await tlsFix.close();
    }
  });

  await runCheck('EX-P2D-9 整链重取恰一次：webtranslate 失效 → 页面+js+key 整链重取恰 1 次重试成功（key GET 总数=2）；仍失败形态不放大', async () => {
    // 子形态 A：重试成功
    const stA = youdaoLoopState();
    stA.webResponder = (n, form) => (n === 2
      ? { status: 200, body: YOUDAO_BAD_CIPHER }
      : { status: 200, body: youdaoEncrypt(JSON.stringify({ translateResult: [[{ tgt: form.i }]] }), 'e1-aes-key', 'e1-aes-iv') });
    const fixA = await makeTlsLoopbackServer(makeYoudaoLoopback(stA));
    e1SetLoopbackRedirect({ 'fanyi.youdao.com': fixA.port, 'dict.youdao.com': fixA.port, 'shared.ydstatic.com': fixA.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'youdao-web', kind: 'youdao-web', enabled: true, order: 0 }]);
      const r1 = await group.translateSegment('整链重取甲'.repeat(6), new AbortController().signal);
      const r2 = await group.translateSegment('整链重取乙'.repeat(6), new AbortController().signal);
      assert.ok(r1.ok, `首段应成功：${r1.error}`);
      assert.ok(r2.ok, `整链重取后重试应成功：${r2.error}`);
      assert.equal(r2.text, '整链重取乙'.repeat(6), '重试译文不符');
      assert.equal(countCaptured(fixA.captured, '/webtranslate/key'), 2, `key GET 总数应恰 2（整链重取恰一次），实得 ${countCaptured(fixA.captured, '/webtranslate/key')}`);
      assert.equal(countCapturedExact(fixA.captured, '/'), 2, `页面 GET 总数应恰 2，实得 ${countCapturedExact(fixA.captured, '/')}`);
      assert.equal(countCaptured(fixA.captured, '/dict/translation-website/'), 1, `js GET 应恰 1（仅重取链路），实得 ${countCaptured(fixA.captured, '/dict/translation-website/')}`);
      assert.equal(countCapturedExact(fixA.captured, '/webtranslate'), 3, `webtranslate POST 应恰 3（两段 + 一次失效重试），实得 ${countCapturedExact(fixA.captured, '/webtranslate')}`);
    } finally {
      e1SetLoopbackRedirect({});
      await fixA.close();
    }
    // 子形态 B：重试仍失败 → 失败终结、整链重取不放大
    const stB = youdaoLoopState();
    stB.webResponder = () => ({ status: 200, body: YOUDAO_BAD_CIPHER });
    const fixB = await makeTlsLoopbackServer(makeYoudaoLoopback(stB));
    e1SetLoopbackRedirect({ 'fanyi.youdao.com': fixB.port, 'dict.youdao.com': fixB.port, 'shared.ydstatic.com': fixB.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'youdao-web', kind: 'youdao-web', enabled: true, order: 0 }]);
      const r = await group.translateSegment('仍失败丙'.repeat(6), new AbortController().signal);
      assert.equal(r.ok, false, '重试仍失败应以失败形态终结');
      assert.equal(countCaptured(fixB.captured, '/webtranslate/key'), 2, `失败形态 key GET 应恰 2（不放大），实得 ${countCaptured(fixB.captured, '/webtranslate/key')}`);
      assert.equal(countCapturedExact(fixB.captured, '/webtranslate'), 2, `失败形态 POST 应恰 2，实得 ${countCapturedExact(fixB.captured, '/webtranslate')}`);
    } finally {
      e1SetLoopbackRedirect({});
      await fixB.close();
    }
  });

  await runCheck('EX-P2D-10 整链重取并发单飞：两段并发同遇 secretKey 失效 → 整链重取恰 1 次、两段都继续', async () => {
    const st = youdaoLoopState();
    // 确定性编排（round-003 flaky 修复，EX-P1-10 同款）：失效按段标记（各段首 POST 恰坏密文一次、重试
    // 恒绿）+ 两段首 POST 到齐后同轮放行 BAD（屏障）→ 两整链重取尝试必然同轮发出 → 单飞恰合并一链
    // （页面 GET 恰 2 由编排确定性保证，不再依赖到达序交错的运气）。
    const segSeen = new Set<string>();
    let openGate!: () => void;
    const gate = new Promise<void>((res) => { openGate = res; });
    let gated = false;
    setTimeout(() => { if (!gated) { gated = true; openGate(); } }, 2000).unref();
    st.webResponder = async (_n, form) => {
      const marker = typeof form.i === 'string' && form.i.includes('并发甲') ? '甲' : typeof form.i === 'string' && form.i.includes('并发乙') ? '乙' : '';
      if (marker && !segSeen.has(marker)) {
        segSeen.add(marker);
        if (segSeen.size >= 2 && !gated) { gated = true; openGate(); }
        await gate;
        return { status: 200, body: YOUDAO_BAD_CIPHER };
      }
      return { status: 200, body: youdaoEncrypt(JSON.stringify({ translateResult: [[{ tgt: form.i }]] }), 'e1-aes-key', 'e1-aes-iv') };
    };
    const tlsFix = await makeTlsLoopbackServer(makeYoudaoLoopback(st));
    e1SetLoopbackRedirect({ 'fanyi.youdao.com': tlsFix.port, 'dict.youdao.com': tlsFix.port, 'shared.ydstatic.com': tlsFix.port });
    try {
      const enginesMod = loadEnginesReal();
      const group = buildE1Group(enginesMod, [{ id: 'youdao-web', kind: 'youdao-web', enabled: true, order: 0 }]);
      const warm = await group.translateSegment('单飞预热'.repeat(6), new AbortController().signal);
      assert.ok(warm.ok, `预热段应成功：${warm.error}`);
      const [ra, rb] = await Promise.all([
        group.translateSegment('并发甲'.repeat(6), new AbortController().signal),
        group.translateSegment('并发乙'.repeat(6), new AbortController().signal),
      ]);
      assert.ok(ra.ok, `并发段甲应继续：${ra.error}`);
      assert.ok(rb.ok, `并发段乙应继续：${rb.error}`);
      assert.equal(countCapturedExact(tlsFix.captured, '/'), 2, `页面 GET 应恰 2（预热 1 + 重取链恰 1 次单飞），实得 ${countCapturedExact(tlsFix.captured, '/')}`);
      assert.equal(countCaptured(tlsFix.captured, '/dict/translation-website/'), 1, `js GET 应恰 1（重取单飞），实得 ${countCaptured(tlsFix.captured, '/dict/translation-website/')}`);
      assert.equal(countCaptured(tlsFix.captured, '/webtranslate/key'), 2, `key GET 应恰 2（重取单飞），实得 ${countCaptured(tlsFix.captured, '/webtranslate/key')}`);
      assert.equal(countCapturedExact(tlsFix.captured, '/webtranslate'), 5, `POST 应恰 5（预热 1 + 两段失效 2 + 重试 2），实得 ${countCapturedExact(tlsFix.captured, '/webtranslate')}`);
    } finally {
      e1SetLoopbackRedirect({});
      await tlsFix.close();
    }
  });

  await runCheck('EX-P2D-11 冷链超时降级：页面挂起慢 stub → 尝试超时内以失败形态终结、组降级 bing 接管（不放大尝试；超时常量经 coreOverrides 注入缩短——语义不变避免 10s 实钟）', async () => {
    const hangFix = await makeTlsLoopbackServer(() => {
      /* 挂起：永不应答（GET 请求体已到 → captured 已记录，响应悬挂至客户端超时中止） */
    });
    const bingFix = await makeTlsLoopbackServer(makeBingLoopback(bingLoopState()));
    e1SetLoopbackRedirect({ 'fanyi.youdao.com': hangFix.port, 'dict.youdao.com': hangFix.port, 'shared.ydstatic.com': hangFix.port });
    try {
      const enginesMod = loadEnginesReal({ coreOverrides: { TRANSLATION_ENGINE_TRY_TIMEOUT_MS: 1200 } });
      const group = buildE1Group(enginesMod, [
        { id: 'youdao-web', kind: 'youdao-web', enabled: true, order: 0 },
        { id: 'bing-web', kind: 'bing-web', enabled: true, order: 1, endpoint: `127.0.0.1:${bingFix.port}` },
      ]);
      const started = Date.now();
      const r = await group.translateSegment('冷链降级'.repeat(6), new AbortController().signal);
      const elapsed = Date.now() - started;
      assert.ok(r.ok, `冷链挂起后组应降级 bing 出译文：${r.error}`);
      assert.equal(r.text, '冷链降级'.repeat(6), '接管译文应为 bing 回显');
      assert.equal([...r.tried].join(','), 'youdao-web,bing-web', `尝试序不符（跨 realm 原型陷阱——join 字面比对）：${r.tried.join(',')}`);
      assert.ok(elapsed < 9000, `应在尝试超时内终结（实耗 ${elapsed}ms）`);
      assert.equal(countCapturedExact(hangFix.captured, '/'), 1, `冷链页面尝试应恰 1 次（超时即失败降级，不放大），实得 ${countCapturedExact(hangFix.captured, '/')}`);
      assert.equal(countCapturedExact(hangFix.captured, '/webtranslate'), 0, '冷链未走完不应出现 webtranslate POST');
      assert.equal(countCaptured(bingFix.captured, '/ttranslatev3'), 1, 'bing 接管应恰 1 次 POST');
    } finally {
      e1SetLoopbackRedirect({});
      await bingFix.close();
      await hangFix.close();
    }
  });

  console.log('=== E1 · 同场补结构钉与探测边界（round-002 C-1 扩容） ===');

  // EX-P7-2b（r1-P2-1 末条；清单 §7.2 EX-P7-2 原文语义）：ConfigPage 名称/端点映射结构钉。
  // 既有名 EX-P7-2 已被 W4 点用于 sanitize seed 行为钉（不重编既有 check），本钉以 EX-P7-2b 承载。
  await runCheck('EX-P7-2b 结构钉（ConfigPage 名称/端点映射）：TRANSLATION_KIND_NAMES 恰五键（无死四）；TRANSLATION_ENDPOINT_SEEDS 恰 bing-web 一非空键', () => {
    const kindNamesBlock = /const TRANSLATION_KIND_NAMES[\s\S]*?=\s*\{([\s\S]*?)\};/.exec(configPageSrc)?.[1];
    assert.ok(kindNamesBlock, 'TRANSLATION_KIND_NAMES 常量缺失');
    const kindKeys = [...kindNamesBlock.matchAll(/'([a-z-]+)'\s*:/g)].map((m) => m[1]);
    assert.deepEqual(
      kindKeys,
      ['bing-web', 'alibaba-web', 'qq-transmart', 'sogou-web', 'youdao-web'],
      `TRANSLATION_KIND_NAMES 键集漂移（应恰五活 kind）：${kindKeys.join(',')}`,
    );
    const seedsBlock = /const TRANSLATION_ENDPOINT_SEEDS[\s\S]*?=\s*\{([\s\S]*?)\};/.exec(configPageSrc)?.[1];
    assert.ok(seedsBlock, 'TRANSLATION_ENDPOINT_SEEDS 常量缺失');
    const seedKeys = [...seedsBlock.matchAll(/'([a-z-]+)'\s*:/g)].map((m) => m[1]);
    assert.deepEqual(seedKeys, kindKeys, `TRANSLATION_ENDPOINT_SEEDS 键集与名称映射不一致：${seedKeys.join(',')}`);
    const seedLines = seedsBlock.split('\n');
    const bingLine = seedLines.find((l) => l.includes("'bing-web'"));
    assert.ok(bingLine?.includes('DEFAULT_BING_WEB_DOMAIN'), `bing-web 种子应为出厂域引用（非空键面）：${bingLine?.trim()}`);
    for (const kind of ['alibaba-web', 'qq-transmart', 'sogou-web', 'youdao-web']) {
      const line = seedLines.find((l) => l.includes(`'${kind}'`));
      assert.ok(line?.includes("''"), `${kind} 种子应为空串（endpoint 不消费——恰 bing 一非空键面）：${line?.trim()}`);
    }
    const nonEmptyCount = seedLines.filter((l) => /'([a-z-]+)'\s*:/.test(l) && !l.includes("''") && !l.includes('DEFAULT_BING_WEB_DOMAIN')).length;
    assert.equal(nonEmptyCount, 0, `endpoint 种子出现 bing 之外的非空键面（${nonEmptyCount} 行）`);
  });

  await runCheck('EX-P2D-12b 结构钉（三 kind endpoint 零消费声明形态）：alibaba/qq/sogou 适配器 void ctx + 代码面 ctx.entry.endpoint 唯一消费点=bing（剥注释判定）', () => {
    const stripComments = (src: string): string => src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const sections: Array<[string, string, string]> = [
      ['alibaba', '// ── alibaba-web', '// ── qq-transmart'],
      ['qq', '// ── qq-transmart', '// ── sogou-web'],
      ['sogou', '// ── sogou-web', '// ── youdao-web'],
    ];
    for (const [name, startMark, endMark] of sections) {
      const start = enginesSrc.indexOf(startMark);
      const end = enginesSrc.indexOf(endMark);
      assert.ok(start >= 0 && end > start, `${name} 段定位失败（${start}..${end}）`);
      const codeOnly = stripComments(enginesSrc.slice(start, end));
      assert.ok(codeOnly.includes('void ctx'), `make${name} 适配器缺 void ctx（endpoint 非消费声明形态缺失）`);
      assert.ok(!codeOnly.includes('ctx.entry.endpoint'), `${name} 适配器代码消费 entry.endpoint（P1-5 违约）`);
    }
    // 全源码代码面 ctx.entry.endpoint 唯一消费点 = bing（makeBingWeb host 装配行）
    const allCode = stripComments(enginesSrc);
    const hits = allCode.split('ctx.entry.endpoint').length - 1;
    assert.equal(hits, 1, `ctx.entry.endpoint 代码面消费点应恰 1 处（bing），实得 ${hits}`);
  });

  await runCheck('RB-MT-T37b 探测缓存恰 5min 边界（r3-F7）：恰 <TTL 复用零请求；Date.now 差值精确等于 TTL → 照旧全量重探（实现为严格 <）', async () => {
    const h = loadServiceProbe();
    h.setScripted((kind) => {
      if (kind === 'bing-web') return { ok: false, error: 'HTTP 503: bing down' };
      const delayMs = kind === 'alibaba-web' ? 10 : kind === 'qq-transmart' ? 30 : kind === 'sogou-web' ? 50 : 70;
      return { ok: true, text: `探@${kind}`, delayMs };
    });
    await (h.mod.probeEngines as (apply: boolean) => Promise<unknown>)(false);
    assert.equal(h.calls.length, 5, '首探请求次数 ≠ 5');
    // 恰 <TTL：显式推进 virtualNow TTL-1ms（虚拟钟不含真实间隙）→ 缓存差值恰 = TTL-1，不过期才复用——零新增请求
    h.clock.advance(5 * 60_000 - 1);
    const probeReuse = await (h.mod.probeEngines as (apply: boolean) => Promise<{ appliedOrder?: string[] }>)(true);
    assert.equal(h.calls.length, 5, `恰 <TTL 时 apply 发生新增请求（严格 < 的下界侧），实得新增 ${h.calls.length - 5}`);
    assert.equal(
      (probeReuse.appliedOrder ?? []).join(','),
      'alibaba-web,qq-transmart,sogou-web,youdao-web,bing-web',
      '恰 <TTL 复用序不符',
    );
    // 恰 =TTL（差值精确等于 PROBE_CACHE_TTL_MS=300000）：严格 < 不含等值 → 照旧全量重探
    h.setScripted((kind) => {
      if (kind === 'alibaba-web') return { ok: false, error: 'HTTP 503: alibaba down' };
      const delayMs = kind === 'bing-web' ? 10 : kind === 'qq-transmart' ? 30 : kind === 'sogou-web' ? 50 : 70;
      return { ok: true, text: `探@${kind}`, delayMs };
    });
    h.clock.advance(1); // 再推 1ms → 缓存差值恰 = PROBE_CACHE_TTL_MS（严格 < 不含等值 → 照旧全量重探）
    const probeExpired = await (h.mod.probeEngines as (apply: boolean) => Promise<{ appliedOrder?: string[] }>)(true);
    assert.equal(h.calls.length, 10, `恰 =TTL 未全量重探（等值应照旧全量——复用窗口做宽 = P2-2 边界回归），新增 ${h.calls.length - 5} 次`);
    assert.equal(
      (probeExpired.appliedOrder ?? []).join(','),
      'bing-web,qq-transmart,sogou-web,youdao-web,alibaba-web',
      '恰 =TTL 重探后 appliedOrder 未反映新结果',
    );
  });

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
