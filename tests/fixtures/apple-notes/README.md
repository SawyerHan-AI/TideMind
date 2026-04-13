# Apple Notes 测试 Fixture 数据库

## 来源

这些 `NoteStore-macOS-*.sqlite` 测试数据库来自
[RhetTbull/apple-notes-parser](https://github.com/RhetTbull/apple-notes-parser)
项目（MIT 许可），路径 `tests/data/`。

## 内容

每个数据库包含一致的虚构测试数据：

- 1 个账户（"On My Mac"）
- 6 个文件夹（Notes / Folder / Folder2 / Subfolder / Subsubfolder / Recently Deleted），含嵌套结构
- 8-9 条测试笔记，涵盖：
  - 纯文本笔记
  - 富文本格式化笔记
  - 含清单（checklist）的笔记
  - 密码保护（加密）笔记
  - 含附件的笔记（bitcoin.pdf）
  - 嵌套文件夹中的笔记
  - 标记为删除的笔记
- 对应的文本快照文件

## 版本覆盖

| 文件 | 对应 macOS 版本 |
|------|----------------|
| `NoteStore-macOS-13-Ventura.sqlite` | 13 (Ventura) |
| `NoteStore-macOS-14-Sonoma.sqlite` | 14 (Sonoma) |
| `NoteStore-macOS-15-Seqoia.sqlite` | 15 (Sequoia) |
| `NoteStore-macOS-26-Tahoe.sqlite` | 26 (Tahoe) |

## 用途

- `database-integration.test.ts`：覆盖 schema 检测、账户/文件夹/笔记查询在跨版本下的正确性
- `protobuf-integration.test.ts`：覆盖 `decodeNoteData` + `buildCleanText` 对 Apple 真实写入的 ZDATA blob 的处理

## 许可

上游项目采用 MIT 许可，允许重新分发。保留原有版权声明即可。
