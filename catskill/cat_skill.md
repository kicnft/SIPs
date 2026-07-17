# CAT Skill: Symbol catbuffer 読解ガイド

この文書は、Symbol SDK を使わずに、catbuffer schema を読んでトランザクションのバイナリを組み立て、アナウンスし、結果を確認したい人のための指南書です。

前提として、必要になった schema は公式リポジトリを見に行って確認します。

- https://github.com/symbol/symbol/tree/dev/catbuffer
- `catbuffer/schemas/symbol`
- `catbuffer/schemas/nem`
- DSL の公式リファレンス: `catbuffer/parser/docs/cats_dsl.md`（この文書にない構文に出会ったらここを引く）

## まず結論

catbuffer schema が読めれば、Symbol トランザクションの binary layout は分かります。つまり、SDK がなくても serializer / deserializer は作れます。

ただし catbuffer は「バイト列の構造」を定義するものです。次の処理は catbuffer だけでは完結しません。

- Ed25519 鍵生成、署名、検証
- SHA3-256、RIPEMD160
- Address の Base32 encode / decode
- Merkle root 計算
- transaction hash 計算
- fee 計算
- deadline 計算
- REST API 呼び出し
- network constants の取得または管理

SDKなしで作る場合は、catbufferで構造を読み、暗号・ハッシュ・REST・ネットワーク定数は別に実装します。

なお、announce の HTTP 200/202 は「受理」にすぎません。`transactionStatus` の confirmed/Success を確認し、
confirmed transaction を読み戻して内容が一致するまでを「成功」と定義します。

## ディレクトリの見方

`catbuffer/schemas` は大きく分かれています。

```text
catbuffer/schemas/
  nem/
  symbol/
```

Symbol mainnet/testnet のトランザクションを作るなら、基本的には `catbuffer/schemas/symbol` を読みます。

代表的なファイル:

```text
symbol/types.cats
symbol/entity.cats
symbol/transaction.cats
symbol/transaction_type.cats
symbol/transfer/transfer.cats
symbol/aggregate/aggregate.cats
symbol/aggregate/cosignature.cats
```

`all.cats`, `all_transactions.cats`, `all_generated.cats` は入口・集約用です。実装時は対象トランザクションの `.cats` から import をたどって読むのが分かりやすいです。

## .cats の基本記法

### `using`

型エイリアスです。

```cats
using Amount = uint64
using PublicKey = binary_fixed(32)
using Signature = binary_fixed(64)
```

読み方:

- `Amount` は little endian の `uint64`
- `PublicKey` は固定長32 byte
- `Signature` は固定長64 byte
- 整数型には符号付きもある（例: metadata 系の `value_size_delta = int16`。little endian の2の補数）

### `enum`

数値列挙です。

```cats
enum TransactionType : uint16
  AGGREGATE_COMPLETE = 0x4141
  TRANSFER = 0x4154
```

読み方:

- enum の保存サイズは `uint16`
- バイト列では little endian
- `TRANSFER = 0x4154` は serialized bytes では `54 41`

### `@is_bitwise`

enum がフラグ集合であることを示します。値は OR で合成して1つの整数として書きます。

```cats
@is_bitwise
enum MosaicFlags : uint8
  NONE = 0x00
  SUPPLY_MUTABLE = 0x01
  TRANSFERABLE = 0x02
  RESTRICTABLE = 0x04
  REVOKABLE = 0x08
```

`SUPPLY_MUTABLE | TRANSFERABLE` なら `0x03` を 1 byte 書きます（MosaicDefinition の flags 等）。

### `struct`

実際にバイト列へ並ぶ構造です。

```cats
struct Mosaic
  mosaic_id = MosaicId
  amount = Amount
```

この場合は `uint64 mosaic_id` の後に `uint64 amount` が続きます。

### `inline struct`

他のstructへ展開される部品です。

```cats
inline struct EntityBody
  signer_public_key = PublicKey
  entity_body_reserved_1 = make_reserved(uint32, 0)
  version = uint8
  network = NetworkType
```

`inline EntityBody` と書かれた場所には、この4フィールドがそのまま展開されます。

### `inline`

継承ではなく、バイト列の展開です。

```cats
struct TransferTransactionV1
  inline Transaction
  inline TransferTransactionBody
```

これは `Transaction` の全フィールドの後に `TransferTransactionBody` の全フィールドを続ける、という意味です。

### `make_const`

固定値です。serializerでは必ずその値を書きます。

```cats
TRANSACTION_VERSION = make_const(uint8, 1)
TRANSACTION_TYPE = make_const(TransactionType, TRANSFER)
```

`TransferTransactionV1` なら version は `1`、type は `TRANSFER` です。

### `make_reserved`

予約領域です。必ず指定値を書きます。通常は `0` です。

```cats
entity_body_reserved_1 = make_reserved(uint32, 0)
```

ここを間違えると deserializer やノード検証で落ちます。

### `array(type, count)`

固定個数の配列です。

```cats
mosaics = array(UnresolvedMosaic, mosaics_count)
message = array(uint8, message_size)
```

直前の `mosaics_count` や `message_size` の値だけ読み書きします。count が 0 なら、そのフィールドは 0 byte（何も書かない）。
message なし Transfer（`message_size = 0`、type byte も含めて書かない）や mosaic なし Transfer（`mosaics_count = 0`）は
この規則から直接導けます。専用の variant はありません。

### `array(type, __FILL__)`

残り領域を埋める配列です。

```cats
cosignatures = array(Cosignature, __FILL__)
```

Aggregate の cosignatures は payload の残りを `Cosignature` 単位で読みます。

### 条件付きフィールド（`if ... equals`）

条件が成立するときだけ serialize されるフィールドです。`namespace_registration.cats` の実例:

```cats
duration = BlockDuration if ROOT equals registration_type
parent_id = NamespaceId if CHILD equals registration_type
```

ROOT なら `duration`、CHILD なら `parent_id` だけが書かれ、両方が同時に現れることはありません（この例ではどちらも8 byteで、
union のように同じ位置を占めます）。注意点:

- **条件の参照先がレイアウト上あとに現れることがある**。この例の `registration_type` は `duration`/`parent_id` より後ろにあり、
  deserialize では condition field を先読みしてから分岐します。
- 変種として `if VALUE not equals field`、bitwise フラグ条件の `if FLAG has field` / `if FLAG not has field` があります。

### `@sort_key`

配列のソート条件です。

```cats
@sort_key(mosaic_id)
mosaics = array(UnresolvedMosaic, mosaics_count)
```

serializerでは `mosaic_id` 昇順に並べます。順序を間違えると、SDK実装やノード検証と一致しない可能性があります。

### `@alignment`

配列要素のアライメントです。

```cats
@alignment(8)
transactions = array(EmbeddedTransaction, payload_size)
```

Aggregate 内の embedded transactions は各要素を8 byte境界に揃えます。要素の実サイズが8の倍数でなければ `0x00` padding を入れます。
**既定では末尾要素にも padding が入ります**（DSL リファレンス cats_dsl.md の規定。`@alignment(x, not pad_last)` と明示された場合だけ
末尾を pad しない。aggregate は修飾なしの `@alignment(8)` なので末尾も pad する）。

### `@is_byte_constrained`

配列の長さが要素数ではなくバイト数で制約されることを示します。

```cats
@is_byte_constrained
@alignment(8)
transactions = array(EmbeddedTransaction, payload_size)
```

`payload_size` は embedded transaction の個数ではなく、padding込みの合計byte数です。

### `@size(size)`

先頭などにある `size` フィールドが構造体全体のサイズを表すことを示します。

```cats
@size(size)
abstract struct Transaction
  inline SizePrefixedEntity
```

`SizePrefixedEntity` の `size = uint32` は、headerを含む全バイト長です。

### `@initializes`

固定値フィールドを初期化するためのメタ情報です。

```cats
@initializes(version, TRANSACTION_VERSION)
@initializes(type, TRANSACTION_TYPE)
```

対象structの `TRANSACTION_VERSION` と `TRANSACTION_TYPE` を、共通ヘッダの `version` と `type` に入れる、という意味です。

### `@discriminator`

deserialize時に、type/version から具体的なstructを選ぶための指定です。

```cats
@discriminator(type, version)
abstract struct Transaction
```

`type = TRANSFER`, `version = 1` なら `TransferTransactionV1` として読む、というように使います。

`abstract struct` は wire に単独では現れず、discriminator で具象 struct を選ぶ factory の基底になります（具象側が
`inline Transaction` で展開する）。修飾なしの struct はそのまま出力され、`inline struct` は展開されて消えます。

### その他のまれな構文

transaction schema では通常出会いませんが、次も DSL に存在します。見かけたら `catbuffer/parser/docs/cats_dsl.md` を引いてください。

- `sizeof(uint16, field)` — 他フィールドの serialize サイズを値に持つフィールド
- `@sizeref(field, adjustment)` — 整数フィールドを他フィールドのサイズで自動初期化
- `@comparer(field !transform)` — ソート時の変換指定（NEM 系が `!ripemd_keccak_256` を使用）
- `name = inline Struct` — プレフィックス付きの named inline 展開
- `@is_aligned` / `@is_size_implicit` — 構造体のアライメント宣言／`sizeof` 参照対応の宣言

## 共通ヘッダを読む

`symbol/entity.cats` と `symbol/transaction.cats` が重要です。

通常トランザクションの共通部分:

```text
SizePrefixedEntity
  size: uint32

VerifiableEntity
  reserved: uint32
  signature: 64 bytes

EntityBody
  signer_public_key: 32 bytes
  reserved: uint32
  version: uint8
  network: uint8

Transaction
  type: uint16
  fee: uint64
  deadline: uint64
```

フラットなバイト並びと絶対 offset は「署名／ハッシュの対象バイト範囲（厳密）」の offset 表と「最小 Transfer を1本組むバイト列順序」を参照してください。

Embedded transaction は署名・fee・deadline を持ちません。

```text
size:uint32
embedded_reserved:uint32
signer_public_key:32
reserved:uint32
version:uint8
network:uint8
type:uint16
body...
```

## Transfer を読む

対象:

```text
symbol/transfer/transfer.cats
```

`TransferTransactionBody` はこう読めます。

```text
recipient_address: UnresolvedAddress = 24 bytes
message_size: uint16
mosaics_count: uint8
reserved_1: uint8 = 0
reserved_2: uint32 = 0
mosaics: UnresolvedMosaic[mosaics_count], sort by mosaic_id
message: uint8[message_size]
```

通常Transferなら:

```text
Transaction common header
TransferTransactionBody
```

EmbeddedTransferなら:

```text
EmbeddedTransaction common header
TransferTransactionBody
```

最小Transferの実装で注意すること:

- recipientは39文字アドレスではなく24 byte decoded addressを書く。
- `message_size` はbyte数。**message type byte を含めた長さ**。
- **message の先頭1 byteは type byte**:
  - `0x00` = 平文（plain）。以降が UTF-8 等の生バイト
  - `0x01` = 暗号化（encrypted）。以降が暗号化ペイロード
  - `0xFE` = 委任ハーベスティング用（通常のメッセージでは使わない）
  - 例: 平文 "hi" なら message = `00 68 69`、`message_size = 3`
- mosaicsは `mosaic_id:uint64 + amount:uint64` を `mosaic_id` 昇順で並べる。
- reserved fieldはゼロ。

## Aggregate を読む

対象:

```text
symbol/aggregate/aggregate.cats
symbol/aggregate/cosignature.cats
```

`AggregateTransactionBody`:

```text
transactions_hash: Hash256 = 32 bytes
payload_size: uint32
reserved: uint32 = 0
transactions: EmbeddedTransaction[], payload_size bytes, alignment 8
cosignatures: Cosignature[], fills remaining body
```

AggregateCompleteTransactionV3:

```text
Transaction common header
AggregateTransactionBody
```

Cosignature:

```text
version: uint64
signer_public_key: PublicKey = 32 bytes
signature: Signature = 64 bytes
```

Aggregate実装で注意すること:

- embedded transactionはaggregateの中にだけ入る。
- embedded transactionはaggregateにできない。
- `payload_size` はpadding込みのembedded payload byte長。
- `transactions_hash` はembedded transaction群からMerkle rootを作る。
- cosignatureを追加したら、aggregate先頭の `size` も増やす。

## Merkle root

Aggregate の `transactions_hash` は次で作ります。

```text
leaf = SHA3-256(serialized_embedded_transaction)
parent = SHA3-256(left || right)
```

同じ段に奇数個のhashがある場合は最後を複製します。

```text
[A, B, C]
=> [H(A||B), H(C||C)]
=> H(H(A||B) || H(C||C))
```

embedded transactionのhashは、paddingなしの実serialized bytesに対して取ります。paddingはaggregate payload上の配置のためであり、leaf hashの入力には含めません。

## Address と UnresolvedAddress

catbuffer上の `Address` / `UnresolvedAddress` は24 byteです。39文字の表示アドレスではありません。

公開鍵からアドレス（`network_byte` = mainnet `0x68` / testnet `0x98`）:

```text
part1 = SHA3-256(public_key)                    # SHA3-256（署名内部の SHA-512 とは別）
part2 = RIPEMD160(part1)                         # 20 byte
versioned = network_byte || part2               # 1 + 20 = 21 byte
checksum = SHA3-256(versioned)[first 3 bytes]   # ★ 3 byte（4ではない）
decoded = versioned || checksum                 # 21 + 3 = 24 byte
b32     = Base32(decoded || 0x00)               # 25 byte = 200 bit → ちょうど40文字（'=' は付かない）
address = b32[0:39]                             # 末尾1文字を捨てて39文字にする
```

内訳は `version(1) + ripemd160(20) + checksum(3) = 24 byte`。serializerに書くのは `decoded` の **24 byte** です。
39文字の表示アドレスを Base32 decode しても同じ24 byteが得られます。

### UnresolvedAddress — 実アドレスか namespace alias か

`recipient_address` 等の `UnresolvedAddress`（24 byte）は、**先頭byteの最下位ビット（LSB）で種別が決まります**。

- **LSB = 0 → 実アドレス**。上記の decoded 24 byte をそのまま書く（mainnet 0x68 / testnet 0x98 は偶数なので LSB=0）
- **LSB = 1 → namespace alias**。次の形式:

```text
byte[0]    = network_byte | 0x01     # LSB を立てる（mainnet 0x69 / testnet 0x99）
byte[1..8] = namespace_id            # uint64 little endian（8 byte）
byte[9..23]= 0x00 * 15               # ゼロ埋め（合計24 byte）
```

通常のアドレスだけを扱う最小実装では実アドレス（LSB=0）だけ対応すればよいです。alias を宛先にするなら上の形式を使います。

## Network と deadline

`entity.cats` の `NetworkType`:

```text
MAINNET = 0x68
TESTNET = 0x98
```

`Timestamp` は network epoch からのミリ秒です。mainnet の epoch adjustment は「よく使う定数」表を参照してください。

deadlineは例えば次のように作ります。

```text
deadline_ms = (utc_now + 2 hours - symbol_epoch_utc).total_milliseconds
```

### generation hash seed（必須・署名に使う）

署名とtransaction hashに必要な32 byteの network 定数です。**catbufferには載っていません。** これが無いと署名は必ず不正になります。

mainnet の値は「よく使う定数」表を参照してください。

取得方法（自分でノードから取るのが安全）:

```text
GET /node/info           → networkGenerationHashSeed
GET /network/properties  → network.generationHashSeed
```

testnet は値が異なります。必ず対象ネットワークのノードから取得してください。

## 署名とハッシュ

catbufferは署名対象そのものを直接説明しません。ここはSymbolのルールとして実装します。ここが最も間違えやすい部分です。

### 使う ed25519 は SHA-512 版（keccak版ではない）

- Symbol の署名は **標準 ed25519**（内部ハッシュ = **SHA-512**、RFC 8032）です。
- ⚠️ 旧 **NEM は ed25519-keccak/sha3 版**で、**Symbol とは互換がありません**。この文書は nem/ と symbol/ の両方に触れますが、
  署名鍵の導出・署名・検証には **必ず SHA-512 版 ed25519** を使ってください。汎用の ed25519 ライブラリ（RFC 8032 準拠）はこれです。
- アドレス導出やmerkleに使う **SHA3-256 / RIPEMD160 と、署名内部の SHA-512 は別物** です。混同しないこと。

### 署名／ハッシュの対象バイト範囲（厳密）

serialized transaction の **先頭108 byte を飛ばした残り** が「transaction data」です。この108 byteは:

```text
size(4) + reserved1(4) + signature(64) + signer_public_key(32) + reserved2(4) = 108
```

つまり **`version` フィールド（offset 108）から** が署名対象です。**signer_public_key は署名データに含まれません**（hash式では別途連結する）。

⚠️ **108 は「通常Tx全体のヘッダ長」ではありません。**
108 は **署名対象開始offset**、つまり `version` の位置です。通常トランザクションでは、この後に
`version(1) + network(1) + type(2) + fee(8) + deadline(8) = 20 byte` が続き、そのさらに後ろから
各トランザクション固有bodyが始まります。

```text
offset 0..107     size/reserved/signature/signer_public_key/reserved = 108 byte
offset 108..127   version/network/type/fee/deadline                 = 20 byte
offset 128..      transaction-specific body
```

したがって、通常Txを手組みするときの全体サイズは:

```text
size = 108 + 20 + transaction_specific_body_size
```

`size = 108 + body_size` と書くと、20 byte 足りない不正payloadになります。PUTが受理されたように見えても、
ノード側でstatusに残らず破棄されたり、検証エラーになります。**PUT前に必ず `size field == serialized.Length` をassertしてください。**

通常トランザクションの署名payload:

```text
sign_bytes = generation_hash_seed(32) || serialized[108 .. end]
signature  = ed25519_sign(private_key, sign_bytes)     # SHA-512 版
```

transaction hash:

```text
SHA3-256(
  signature(64) ||
  signer_public_key(32) ||
  generation_hash_seed(32) ||
  serialized[108 .. data_end]
)
```

**Aggregate v3 では `serialized[108 .. data_end]` の `data_end` を切り詰めます。** 埋め込みTxと連署は署名／ハッシュ対象に含めません:

```text
data_end = 108 + 56       # v3。56 = version1+network1+type2 + fee8 + deadline8 + transactions_hash32 + payload_size4
                          # （旧 v2 系は 108 + 52）
```

### 連署（cosignature）

cosignatureは、**aggregate の transaction hash そのもの** に ed25519（SHA-512版）で署名します。

```text
cosignature.signature = ed25519_sign(cosigner_private_key, aggregate_transaction_hash)
```

連署を追加したら aggregate 先頭の `size` を `+104`（version8+signer32+signature64）／連署ごとに更新します。

## Fee

fee計算はcatbuffer schemaには直接書かれていません。ノードのfee multiplierや運用方針で決めます。

基本形:

```text
fee = multiplier * transaction_size
```

実務上は **multiplier = 100** を固定で使えば十分です（100未満は承認が遅くなることがある）。
混雑に合わせるなら `GET /blocks?order=desc&pageSize=1` の `feeMultiplier` を参照します。

Aggregateではcosignature分も考慮します。**二重計上に注意**——ここでの `aggregate_size` は
**cosignature を含める前のサイズ** で、連署分は `104 * count` として別に足します。

```text
fee = multiplier * (aggregate_size_without_cosignatures + 104 * required_cosigner_count)
```

実装時は次の順が安全です。

1. feeを仮値でserializeする。
2. sizeを確定する。
3. feeを計算する。
4. feeを入れて再serializeする。
5. size fieldと実バイト長を比較する。

Aggregate では 2 の size 確定を**連署を付ける前**に行います（これが上式の `aggregate_size_without_cosignatures`。連署追加時の size 更新は「連署（cosignature）」節を参照）。

## RESTでアナウンスする

announce の前に、送信元アカウントの残高を確認します。必要残高は `送金額 + fee(maxFee)` です。

```http
GET /accounts/{address}
```

`{address}` は39文字アドレス（ハイフンなし）でよく、レスポンスの `account.mosaics[]` から currency mosaic（XYM）の
`amount` を読みます。**未使用アカウントは 404 が返ります**——エラーではなく「チェーン上に状態がない = 残高ゼロ」として扱います。
残高不足のまま announce すると `Failure_Core_Insufficient_Balance` になります。メッセージ記録だけが目的なら
`mosaics_count = 0` にして送金額をゼロにでき、必要残高は fee のみです（実測: message 5 byte の Transfer で全体 165 byte、
multiplier 100 で fee 16,500 µXYM）。

payloadは署名済みtransaction bytesをhex化したものです。

```http
PUT /transactions
Content-Type: application/json

{"payload":"..."}
```

**PUT のレスポンスを必ず読むこと。** serialize/署名のバグはほぼここか、後述の `transactionStatus` の `Failure_*` で判明します。

```text
HTTP 200/202 → 受理（unconfirmed へ）。確定は transactionStatus で確認
HTTP 400     → payload 不正。本文 {"code":"...","message":"..."} の message を読む（size不一致・reserved非ゼロ・署名不正 等）
```

ノードURLは固定で持たず（この文書にも実装にも直書きしない）、実行時に自律的に探します。候補集めにはノードリストサイトが使えます（例）:

```text
https://symbol-tools.com/symbolTools/view/tool/nodeList.html
https://symbolnodes.org/nodes/
https://symbol.fyi/nodes
```

リストに載っていても停止中・同期遅れのノードは普通にあります。候補は**必ず次の「RESTノードを自律的に選択する」の手順で疎通・検証してから**使います。

### RESTノードを自律的に選択する

固定URLを1つだけ決め打ちしないこと。Symbol のRESTノードは停止・同期遅れ・証明書エラー・testnet resetなどで使えなくなります。
実装者、特にAIエージェントは、実行時に候補ノードを複数集め、疎通とネットワーク情報を検証してから使います。

基本方針:

1. 候補ノードを複数集める。上記のノードリストサイト、前回成功ノード、ユーザー指定、Web検索結果など。
2. 各ノードに `GET /node/health` を投げる。
3. `apiNode == up` かつ `db == up` のものだけ残す。
4. `GET /node/info` を投げる。
5. `networkIdentifier` が目的ネットワークと一致することを確認する。
   - mainnet: `104` (`0x68`)
   - testnet: `152` (`0x98`)
   - `/node/info` の `networkIdentifier` は JSON の**整数**。`/network/properties` の `network.identifier` は文字列 `"mainnet"` / `"testnet"` で別物。比較は整数の方で行う。
6. `networkGenerationHashSeed` を取得し、署名payloadに使う。
7. `GET /network/properties` を投げる。
8. `network.epochAdjustment` を取得し、deadline計算に使う。
9. `GET /chain/info` でheightを確認し、同期遅れのノードを避ける。
10. announce後はPUT先だけでなく、必要なら別ノードでも `transactionStatus` / `transactions/confirmed` を確認する。

必ず取得する値:

| 値 | 取得元 | 用途 |
|---|---|---|
| `networkIdentifier` | `/node/info` | mainnet/testnet取り違え防止 |
| `networkGenerationHashSeed` | `/node/info` | 署名payloadに必須 |
| `epochAdjustment` | `/network/properties` | deadline計算に必須 |
| `currencyMosaicId` | `/network/properties` | XYM/test XYM の mosaic id 確認 |
| `height` | `/chain/info` | 同期遅れノードの除外 |

取得した値の**表記**にも注意します。`/network/properties` は設定ファイル由来の文字列をそのまま返すため、
`currencyMosaicId` は `0x6BED'913F'A202'23F8`、`epochAdjustment` は `1615853185s` のような形式です。比較・変換の前に
`0x`・`'`・単位サフィックス（`s`）を除去して数値化します。また REST の uint64（残高・height 等）は JSON では
10進文字列で返るので、これも数値化してから扱います。

署名前に、次の3点が同じネットワークを指すことを検証します（不一致のまま announce しない）:

```text
node の networkIdentifier == transaction の network byte == recipient_address[0] & 0xFE
```

`networkIdentifier`（104/152）は network byte（`0x68`/`0x98`）と同じ値なのでそのまま比較できます。recipient の先頭 byte は
namespace alias のとき LSB が立つ（`0x69`/`0x99`）ため、`& 0xFE` で LSB を除いて比較します。

testnetはresetされる可能性があるため、`generationHashSeed` と `epochAdjustment` を古い定数や記憶で固定せず、
**実行時に生きているノードを探し、`/node/info` と `/network/properties` から現在値を取得して使います。**
古い `epochAdjustment` は `Failure_Core_Future_Deadline` / `Failure_Core_Past_Deadline` になります。

疑似コード:

```text
candidates = collect_candidate_nodes(network)

healthy = []
for node in candidates:
    health = GET node + "/node/health"
    if health.status.apiNode != "up" or health.status.db != "up":
        continue

    info = GET node + "/node/info"
    if info.networkIdentifier != expected_network_identifier:
        continue

    props = GET node + "/network/properties"
    chain = GET node + "/chain/info"

    healthy.append({
        node,
        generation_hash_seed: info.networkGenerationHashSeed,
        epoch_adjustment: parse_seconds(props.network.epochAdjustment),
        currency_mosaic_id: props.chain.currencyMosaicId,
        height: chain.height
    })

choose node with highest height, or first sufficiently fresh node
```

`PUT /transactions` が成功しても、そのノードが伝播に失敗することがあります。`transactionStatus` の 404 が数回の再試行後も続く場合は、
別ノードでも確認します。それでも見つからない場合は、ローカル計算したtx hashと実payloadが一致していない、size fieldが実長と
一致していない、またはノードが検証前に破棄した可能性を疑います。

ステータス確認:

```http
GET /transactionStatus/{hash}
```

主な状態:

```text
HTTP 404                         announce 直後は未反映で正常。数秒待って再試行
group=unconfirmed, code=Success  受理済み、ブロック待ち
group=confirmed,   code=Success  確定
group=failed,      code=Failure_* 検証失敗（code を必ず読む）
```

confirmed になるまで必ず `transactionStatus` をpollingします。`group=failed` のときの `code`
（`Failure_Core_Insufficient_Balance` / `Failure_Aggregate_*` / `Failure_Signature_Not_Verifiable` 等）が原因を示します。

「成功」の判定は confirmed/Success で終わりにしません。`GET /transactions/confirmed/{hash}` でトランザクションを読み戻し、
message や mosaics が意図どおりかまで確認して、初めて成功と報告します。

### 実行環境の制限とノード疎通の切り分け

全候補ノードへの接続が失敗したとき、原因はノード側とは限りません。名前解決失敗・接続拒否・`Access is denied` が
**候補をまたいで同じ形で揃う**のは、ノード停止ではなく実行環境側の制限（サンドボックス・ファイアウォール・プロキシ）の典型的なシグナルです。
直ちに「全ノードが停止している」「Python が使えない」と結論づけないこと。

1. 失敗を最小コマンドで再現する（例: 1ノードへの `GET /node/health` を1回だけ）。
2. 環境制限の可能性があるなら、同じ最小コマンドをサンドボックス外・権限昇格後に再実行し、前後の結果を比較して
   実装エラーか環境制限かを確定させる。AIエージェントは勝手に回避せず、再実行の承認をユーザーに求める。
3. 試行した全ノードの URL・対象 API・結果（HTTP ステータスまたは例外）を記録し、最終報告に含める。
4. 制限の回避を目的に、ユーザーが参照を禁止したフォルダや既存実装を調べない。

ツールの実行失敗も同じ発想で切り分けます。Windows では `python` が Microsoft Store のスタブ等の別実体を指すことがあるため、
`where.exe python` で実体を確認し、疑わしければフルパスで起動します。

## catbuffer読解の実践手順

任意のトランザクションを実装するときは、次の順に読みます。

1. `transaction_type.cats` で type id を確認する。
2. 対象ディレクトリの `.cats` を開く。
3. `struct XxxTransactionVn` の latest version を選ぶ。
4. `inline Transaction` か `inline EmbeddedTransaction` かを見る。
5. bodyの `inline struct` を読む。
6. `import` をたどって未解決型を見る。
7. `types.cats` で基本型のbyte長を見る。
8. `array` の count field を確認する。
9. `@sort_key` と `@alignment` を確認する。
10. `make_reserved` をゼロで書く。
11. `make_const` を固定値として書く。
12. 最後に size field と実バイト長を照合する。

## 入出力の境界と自己検証（catbuffer の外側で一番落ちる所）

catbuffer が正しく組めても、実装は「バイトを組む前後の外縁」で落ちます。中核（構造・署名・アドレス導出）とは別に、次の入口作法と自己検証を用意しておくと、資金を動かす前に自分のバグに気づけます。

### アドレス文字列は3つの表示形がある

ウォレットやエクスプローラは既定でハイフン区切りで見せます。同じアドレスでも:

- 39文字の生 Base32（大文字）: `NB6QOVCUOFRCF5QJSKPIQMLUVWGJS3KYFC6J77Y`
- 6文字ごとのハイフン区切り（ウォレット既定表示）: `NB6QOV-CUOFRC-F5QJSK-PIQMLU-VWGJS3-KYFC6J-77Y`
- 24 byte のバイナリ（serializer に書くのはこれ）

**アドレス文字列を受け取る関数は、必ず正規化してから Base32 decode する。**

```text
s = s.replace('-', '').replace(' ', '').strip().upper()   # ハイフン・空白除去、大文字化
assert len(s) == 39
decoded = Base32(s + '=')          # 39文字 → '=' を1つ足して40文字 → decode
address_24 = decoded[0:24]         # decode 結果はちょうど24 byte（防御的に先頭24 byteだけ使う）
# 検証: address_24[21:24] == SHA3-256(address_24[0:21])[0:3]   （checksum 3 byte）
#       address_24[0] は 0x68/0x98 等。LSB=1 は namespace alias
```

正規化を忘れると、ハイフン付き文字列で `Non-base32 digit found`、小文字で decode 失敗になります。

### 秘密鍵 hex も入口で正規化する

`0x` 前置・空白・大小のゆらぎを吸収してから `bytes.fromhex`:

```text
k = k.strip().replace(' ', '')
if k.lower().startswith('0x'): k = k[2:]
assert len(k) == 64            # 32 byte seed = 64 hex
private_key = bytes.fromhex(k.lower())
```

Symbol の秘密鍵は 32 byte の seed（64 hex）です。展開後の 64 byte 鍵ではありません。

秘密鍵をソースコード・デフォルト値・ログ・最終報告に書かないこと（`GOLDEN` の seed=1 のような資産のない使い捨て鍵は除く）。
環境変数か標準入力で受け取り、受け取った直後に公開鍵とアドレスを導出してユーザーの期待値と照合します——鍵の取り違えや
打ち間違いをこの時点で検出できます。

### RIPEMD160 は「hashlib にあるとは限らない」

アドレス導出に使う RIPEMD160 は、**OpenSSL 3.0 系（legacy provider 無効）の環境では標準ライブラリから消えている**ことがあります（近年の Linux や一部の Python 配布で発生）。`hashlib.new('ripemd160')` が例外になったらフォールバックする。**下の「貼れる実装」の `ripemd160()` をそのまま使うこと**（`_ripemd160_pure` を同梱済み・実機で hashlib と一致検証済み）:

```python
def ripemd160(data: bytes) -> bytes:
    try:
        h = hashlib.new("ripemd160"); h.update(data); return h.digest()
    except (ValueError, TypeError):
        return _ripemd160_pure(data)   # 貼れる実装に同梱
```

SHA3-256 とは別物です。取り違えるとアドレスが変わり、別人に送金します。

### 自己検証ベクタ（実 XYM を動かす前に必ず通す）

「秘密鍵 → 公開鍵 → アドレス」と「アドレス文字列 → 24 byte」の**正解値**を1組持っておけば、中核も外縁もまとめて検証できます。正解値は mainnet の使い捨てベクタ（seed = 1、資産なし・ドキュメント用）で、**後述「貼れる実装」の `GOLDEN` に1箇所だけ置いてあります**（`private_key` / `public_key` / `address_24` / `address_39`）。

自己検証（実装が正しければ全て一致する）:

```text
derive_public_key(GOLDEN.private_key)             == GOLDEN.public_key   # ed25519(SHA-512)。NEM keccak版では不一致
sha3_256→ripemd160→ver(0x68)→checksum → 24 byte   == GOLDEN.address_24   # 違えば ripemd160/SHA3 取り違えか checksum長
Base32(address_24 || 0x00)[0:39]                  == GOLDEN.address_39
decode(GOLDEN.address_39 のハイフン区切り形)       == GOLDEN.address_24   # ハイフン付きでも一致 = 入口正規化OK
```

一致しないなら、ノードへ announce する前にここで止めます。**実運用の鍵をこのベクタに使わないこと**（公式 test-vectors か、`GOLDEN` のような使い捨て鍵を使う）。testnet を使うなら version byte を `0x98` にして自分でベクタを1組作り直します。

### 署名済みペイロードのゴールデン値（アドレスKATだけでは足りない）

上のアドレスKATは **鍵→公開鍵→アドレスの導出**しか検証しません。**serialize/署名段のバグ**——フィールドの絶対 offset 間違い・fee の書き場所・署名対象範囲——は、アドレスKATが緑でもすり抜けます。実際によくあるのが:

> **fee を `signature` の直後（offset 72 = `signer_public_key`）に書いてしまい公開鍵を破壊、本来の fee フィールド（offset 112）は 0 のまま。**

これはアドレスKATを通過し、announce して初めて `Failure_Signature_Not_Verifiable`（署名と公開鍵が不一致）で落ちます。捕まえるには、**固定入力 → 署名済みバイト列全体**を突き合わせるゴールデン値を1本持ちます。

固定入力（mainnet・使い捨て鍵）と、期待される署名済みペイロード（181 byte）・transaction hash は、すべて後述 `GOLDEN` の
`private_key` / `mosaic_id` / `amount` / `message` / `deadline_ms` / `fee` / `payload` / `tx_hash` です。このベクタは**バイト比較専用**です——
`GOLDEN["payload"]` を announce することはありません（deadline が過去の固定値なので、送っても `Failure_Core_Past_Deadline` になるだけです）。入力の補足:

```text
recipient   = GOLDEN.address_39（= seed=1 の鍵の自分宛て）
mosaic      = XYM, amount は µXYM 単位（1000000 = 1 XYM）
message     = 平文 "test" → 00 74 65 73 74（message_size = 5）
deadline_ms = 固定値 ★必ずこの値で serialize する（時計依存を排除するため）
fee         = 100 × size(181)。仮 serialize 後に確定
```

`GOLDEN["payload"]` を絶対 offset で分解すると、各フィールドの正しい位置が確定します:

```text
offset  len  field                値（この固定入力での例）
0       4    size                 B5000000            = 181
4       4    reserved1            00000000            = 0
8       64   signature            （署名後に埋める。署名前はゼロ）
72      32   signer_public_key    4CB5ABF6…A5BA29     ★ここは公開鍵。fee を書かない
104     4    reserved2            00000000            = 0
108     1    version              01
109     1    network              68                  （mainnet）
110     2    type                 5441                = 0x4154 (Transfer, LE)
112     8    fee                  B446000000000000    = 18100   ★fee はここ（signature 直後ではない）
120     8    deadline             00E8764817000000    = 100000000000
128     24   recipient_address    687D0754…BC9FFF
152     2    message_size         0500                = 5
154     1    mosaics_count        01
155     1    reserved_1           00
156     4    reserved_2           00000000
160     8    mosaic_id            F82302A23F91ED6B    = 0x6BED913FA20223F8 (LE)
168     8    amount               40420F0000000000    = 1000000
176     5    message              0074657374          = 0x00(平文) + "test"
```

自己検証（実装が正しければ両方一致）:

```text
build_signed_transfer(GOLDEN の固定入力) を hex 化 == GOLDEN["payload"]   # 1 byte でも違えば serialize/署名にバグ
transaction_hash(payload)                          == GOLDEN["tx_hash"]
```

アドレスKATとこの署名ペイロードKATの**両方**が緑なら、外縁（入力処理）と中核（serialize/署名/hash）の両方が健全です。announce はその後。

補足（署名ライブラリの落とし穴）: 署名は **detached ed25519（SHA-512）で 64 byte だけ**を取り出して offset 8 に埋めます。API はライブラリで異なります——例えば PyNaCl は `SigningKey(seed).sign(msg).signature` が detached 署名で、`nacl.bindings.crypto_sign_detached` は環境によって存在しません。`sign()` の戻り値全体（署名+メッセージ連結）をそのまま書くと壊れます。`cryptography` での正しい呼び出しは、次の「貼れる実装」の `derive_public_key` / `ed25519_sign` です。

### Aggregate のゴールデン値（padding・Merkle・署名範囲を縛る）

Transfer のゴールデン値は aggregate 固有のロジック——embedded ヘッダ（48 byte）、8 byte padding（**末尾要素含む**）、
Merkle root、v3 署名範囲の切り詰め——を検証しません。`GOLDEN` の `agg_*` がそれを縛る第2のベクタです（同じく**バイト比較専用**）。

固定入力: 同じ seed=1 の鍵で、自分宛て message-only（`mosaics_count = 0`）の Embedded Transfer を2つ
（message は平文 `GOLDEN["agg_messages"]`、`deadline_ms` は Transfer と同じ固定値、fee = 100 × size）。

途中経過のチェックポイント（どの段で壊れたか二分できる）:

```text
embedded 1本の size = 85         # 48 + 37。8の倍数でないので padding が必ず入る
padded              = 88 × 2本   # 末尾要素にも padding が入る
payload_size        = 176        # 8の倍数になっていること
transactions_hash   = GOLDEN["agg_transactions_hash"]   # leaf は padding なしの85 byte
署名対象            = generationHashSeed || serialized[108:164]
全体 size / fee     = 344 / 34400
最終比較            = GOLDEN["agg_payload"] / GOLDEN["agg_tx_hash"]
```

`selftest()` の `build_signed_aggregate` 引数（省略可）に自分の builder を渡すと自動で照合されます。
この builder 構成は testnet で confirmed・読み戻し一致まで実証済みです（末尾 padding を誤ると `payload_size` がズレて必ず拒否されます）。

### 貼れる実装（ripemd160 フォールバック + selftest）

以下は**そのまま自分のスクリプトに入れて使う**前提のコードです（`cryptography` + stdlib のみ・実機で `selftest OK` と、上のゴールデン値の完全再現、fee 位置ずれバグの検出を確認済み）。`build_signed_transfer` は**あなたの serializer に置き換えて構いません**が、**`deadline_ms` を引数に取れる形にしておくこと**——そうしないと self-test でゴールデン値と照合できません（本番は `deadline_ms = (now + 2h - epoch) * 1000`、self-test では固定値を渡す）。

```python
import struct, hashlib
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

def derive_public_key(seed32: bytes) -> bytes:
    """32 byte seed → 32 byte 公開鍵（ed25519 SHA-512 版）。selftest にそのまま渡せる"""
    sk = Ed25519PrivateKey.from_private_bytes(seed32)
    return sk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)

def ed25519_sign(seed32: bytes, message: bytes) -> bytes:
    """detached 署名 64 byte を返す（署名+メッセージ連結ではない）"""
    return Ed25519PrivateKey.from_private_bytes(seed32).sign(message)

def _ripemd160_pure(message: bytes) -> bytes:
    def rol(x, n): return ((x << n) | (x >> (32 - n))) & 0xffffffff
    def f(j, x, y, z):
        if j < 16: return x ^ y ^ z
        if j < 32: return (x & y) | (~x & z)
        if j < 48: return (x | ~y) ^ z
        if j < 64: return (x & z) | (y & ~z)
        return x ^ (y | ~z)
    K  = [0x00000000,0x5A827999,0x6ED9EBA1,0x8F1BBCDC,0xA953FD4E]
    KK = [0x50A28BE6,0x5C4DD124,0x6D703EF3,0x7A6D76E9,0x00000000]
    R  = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15, 7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,
          3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12, 1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,
          4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13]
    RR = [5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12, 6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,
          15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13, 8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,
          12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11]
    S  = [11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8, 7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,
          11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5, 11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,
          9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6]
    SS = [8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6, 9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,
          9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5, 15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,
          8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11]
    h0,h1,h2,h3,h4 = 0x67452301,0xEFCDAB89,0x98BADCFE,0x10325476,0xC3D2E1F0
    ml = len(message); message += b"\x80"
    while len(message) % 64 != 56: message += b"\x00"
    message += struct.pack("<Q", ml * 8)
    for off in range(0, len(message), 64):
        X = list(struct.unpack("<16I", message[off:off+64]))
        A,B,C,D,E = h0,h1,h2,h3,h4; AA,BB,CC,DD,EE = h0,h1,h2,h3,h4
        for j in range(80):
            T = (rol((A + f(j,B,C,D) + X[R[j]] + K[j//16]) & 0xffffffff, S[j]) + E) & 0xffffffff
            A,E,D,C,B = E,D,rol(C,10),B,T
            T = (rol((AA + f(79-j,BB,CC,DD) + X[RR[j]] + KK[j//16]) & 0xffffffff, SS[j]) + EE) & 0xffffffff
            AA,EE,DD,CC,BB = EE,DD,rol(CC,10),BB,T
        T=(h1+C+DD)&0xffffffff; h1=(h2+D+EE)&0xffffffff; h2=(h3+E+AA)&0xffffffff
        h3=(h4+A+BB)&0xffffffff; h4=(h0+B+CC)&0xffffffff; h0=T
    return struct.pack("<5I", h0,h1,h2,h3,h4)

def ripemd160(data: bytes) -> bytes:
    try:
        h = hashlib.new("ripemd160"); h.update(data); return h.digest()
    except (ValueError, TypeError):
        return _ripemd160_pure(data)

# ---- 固定ゴールデン値（mainnet・使い捨て鍵 seed=1・資産なし）----
GOLDEN = {
    "private_key": "0000000000000000000000000000000000000000000000000000000000000001",
    "public_key":  "4CB5ABF6AD79FBF5ABBCCAFCC269D85CD2651ED4B885B5869F241AEDF0A5BA29",
    "address_39":  "NB6QOVCUOFRCF5QJSKPIQMLUVWGJS3KYFC6J77Y",
    "address_24":  "687D075454716222F609929E883174AD8C996D5828BC9FFF",  # mainnet 0x68 版（selftest では導出値と比較する側）
    "mosaic_id":   0x6BED913FA20223F8,   # XYM
    "amount":      1000000,              # µXYM
    "message":     b"test",              # 平文（0x00 は builder が付与）
    "deadline_ms": 100000000000,         # 固定（時計依存を排除）
    "fee":         18100,
    "tx_hash":     "D09D83904A071F6FAFA5DD9215C95854A002C6DA680C44A6FCBD5555B6542DDB",
    "payload":     ("B50000000000000029F3FB45B0C872B756E0F36EB51719F3367CBC76F60E22EF1FAF8BB99D70E382"
                    "D4C4D8492E52BD8F77EC2613B52A85BEFDEF47530DC23D3028522EEEE6FDE30F4CB5ABF6AD79FBF5"
                    "ABBCCAFCC269D85CD2651ED4B885B5869F241AEDF0A5BA290000000001685441B44600000000000000"
                    "E8764817000000687D075454716222F609929E883174AD8C996D5828BC9FFF0500010000000000F823"
                    "02A23F91ED6B40420F00000000000074657374"),
    # ---- Aggregate v3（同じ鍵・自分宛て message-only Embedded Transfer×2）----
    "agg_messages":          [b"agg1", b"agg2"],   # 平文（0x00 は builder が付与）
    "agg_fee":               34400,                # = 100 × size 344
    "agg_transactions_hash": "C00A5A5C47E525AB171788E4D83A2CB4954B2E350BCAC5A2273293E232581EAA",
    "agg_tx_hash":           "DF08AE463F6C7F27616DFC3A8F7172DB1DFE6CE60B43A769035922BFD82EF763",
    "agg_payload":           ("5801000000000000E6F7D849FA908F23FF0D3D3E4F1A96ACA57A8F436D6CD8981307BBA73ABEA2DC"
                              "78F6B18193DE8163F949F5F1E253D5A83575D5E26CF3AE5D8B34A50802716B0B4CB5ABF6AD79FBF5"
                              "ABBCCAFCC269D85CD2651ED4B885B5869F241AEDF0A5BA2900000000036841416086000000000000"
                              "00E8764817000000C00A5A5C47E525AB171788E4D83A2CB4954B2E350BCAC5A2273293E232581EAA"
                              "B00000000000000055000000000000004CB5ABF6AD79FBF5ABBCCAFCC269D85CD2651ED4B885B586"
                              "9F241AEDF0A5BA290000000001685441687D075454716222F609929E883174AD8C996D5828BC9FFF"
                              "0500000000000000006167673100000055000000000000004CB5ABF6AD79FBF5ABBCCAFCC269D85C"
                              "D2651ED4B885B5869F241AEDF0A5BA290000000001685441687D075454716222F609929E883174AD"
                              "8C996D5828BC9FFF05000000000000000061676732000000"),
}

def selftest(build_signed_transfer, derive_public_key, derive_address,
             base32_encode_addr, base32_decode_addr, gen_hash_seed_hex,
             build_signed_aggregate=None):
    """announce の前に必ず呼ぶ。外縁（鍵/アドレス/正規化）と中核（serialize/署名/hash）を両方縛る。
       引数はあなたの実装の関数を渡す。1つでも AssertionError なら announce しない。"""
    seed = bytes.fromhex(GOLDEN["private_key"])
    pub = derive_public_key(seed)
    assert pub.hex().upper() == GOLDEN["public_key"], "pubkey mismatch: ed25519/鍵導出"
    addr = derive_address(pub, 0x68)
    assert base32_encode_addr(addr) == GOLDEN["address_39"], "address mismatch: sha3/ripemd/checksum"
    assert base32_decode_addr("NB6QOV-CUOFRC-F5QJSK-PIQMLU-VWGJS3-KYFC6J-77Y") == addr, "hyphen 正規化NG"
    tx, tx_hash = build_signed_transfer(
        seed32=seed, recipient_24=addr, amount=GOLDEN["amount"], message=GOLDEN["message"],
        mosaic_id=GOLDEN["mosaic_id"], deadline_ms=GOLDEN["deadline_ms"],
        gen_hash_seed=bytes.fromhex(gen_hash_seed_hex))
    assert tx.hex().upper() == GOLDEN["payload"], "payload mismatch: serialize/offset/署名にバグ"
    assert tx_hash == GOLDEN["tx_hash"], "tx_hash mismatch"
    if build_signed_aggregate is not None:
        agg, agg_hash = build_signed_aggregate(
            seed32=seed, recipient_24=addr, messages=GOLDEN["agg_messages"],
            deadline_ms=GOLDEN["deadline_ms"], gen_hash_seed=bytes.fromhex(gen_hash_seed_hex))
        assert agg.hex().upper() == GOLDEN["agg_payload"], "agg payload mismatch: padding/merkle/署名範囲にバグ"
        assert agg_hash == GOLDEN["agg_tx_hash"], "agg tx_hash mismatch"
    print("selftest OK")
```

`build_signed_transfer` の引数名（`seed32 / recipient_24 / amount / message / mosaic_id / deadline_ms / gen_hash_seed`）に自分の実装を合わせるか、`selftest` 側の呼び出しを合わせます。

## デバッグ checklist

catbuffer実装が壊れているときは、だいたい以下です。

- `size` field と実バイト長が一致していない。
- `uint16` / `uint32` / `uint64` の endian が違う。
- reserved field がゼロではない。
- embedded transaction の8 byte paddingを忘れている（末尾要素の padding 漏れが典型。`payload_size` は常に8の倍数になる）。
- paddingをMerkle leaf hashに含めている。
- `payload_size` を要素数だと思っている。
- `mosaics` をsortしていない。
- 表示アドレス39文字をそのまま書いている。
- `UnresolvedAddress` と `Address` の24 byte表現を混同している。
- node の `networkIdentifier`・tx の network byte・recipient 先頭 byte（alias は LSB を除く）の3点一致を署名前に確認していない。
- aggregateにcosignatureを追加した後、先頭の `size` を更新していない。
- aggregate v3のsigning payload範囲を全payloadにしている。
- ハイフン付き・小文字のアドレス文字列を正規化せず Base32 decode している（`Non-base32 digit found`）。
- 秘密鍵 hex の `0x` 前置・空白を除去していない。
- `hashlib.new('ripemd160')` が無い環境（OpenSSL 3.0）で例外を握り潰し、アドレス導出が動いていない。
- RIPEMD160 と SHA3-256 を取り違えている（アドレスが別物になる）。
- **fee を `signature` 直後（offset 72 = signer_public_key）に書いて公開鍵を壊している**（fee は offset 112）。`Failure_Signature_Not_Verifiable` の典型。
- 署名済みペイロードがゴールデン値と一致しない（フィールド offset・fee 位置・署名対象範囲のいずれか）。
- 署名ライブラリの detached 署名 API を取り違え、64 byte 以外（署名+メッセージ連結など）を offset 8 に埋めている。

## 最小実装の部品表

SDKなしで動かすなら、最低限これを用意します。

- `.cats` を読むための人間またはgenerator
- little endian writer/reader
- fixed binary type writer/reader
- array writer/reader
- alignment/padding処理
- discriminatorによるdeserialize振り分け
- Ed25519（**SHA-512版**。NEM の keccak版ではない）
- SHA3-256
- RIPEMD160（hashlib に無い環境あり＝OpenSSL 3.0。フォールバックを用意）
- Base32（アドレス文字列は入口でハイフン・空白除去＋大文字化して正規化）
- Merkle hash builder
- transaction hash builder
- generation hash seed（ノードから取得。署名に必須）
- REST client
- transactionStatus polling

最初はTransferとAggregateCompleteだけ手書きしてもよいですが、長く使うなら `catbuffer/schemas` からserializer/deserializerを生成する小さなgeneratorを作るのが安全です。

## モザイクID / ネームスペースID の導出（Transfer/Aggregate だけなら不要）

MosaicDefinition や NamespaceRegistration を扱うときに必要になる `id` の導出です。**これは catbuffer には無いアルゴリズム**なので別に実装します。Transfer と AggregateComplete しか使わないなら不要です。

モザイクID（owner address 24 byte と 32bit nonce から）:

```text
digest = SHA3-256( nonce(uint32 little endian, 4 byte) || owner_address(24 byte) )
mosaic_id = uint64_le( digest[0..8] )
mosaic_id = mosaic_id & 0x7FFFFFFFFFFFFFFF   # 最上位ビットを落とす（namespace と区別）
```

ネームスペースID（name と親ID から。rootは parent=0）:

```text
digest = SHA3-256( parent_namespace_id(uint64 little endian, 8 byte) || name(utf8 bytes) )
namespace_id = uint64_le( digest[0..8] ) | 0x8000000000000000   # 最上位ビットを立てる
```

- `foo.bar` のような多階層は、`foo` を root（parent=0）で作り、その id を親に `bar` を作る、と順に辿ります。
- 最上位ビット（`0x8000000000000000`）が **1 なら namespace、0 なら mosaic** という住み分けです。
- 名前は小文字英数と `_ -` のみ、先頭は英数字。

## よく使う定数（実測・serializer に直接使える）

文書内ではこの表がネットワーク定数の一次ソースで、本文は値を再掲せずこの表を参照します（テストベクタの一次ソースは `GOLDEN`）。
実行時は `generationHashSeed` と `epochAdjustment` をノードから取得し、この表の値は取得結果の照合に使います（「RESTノードを自律的に選択する」参照。testnet は reset で変わるため取得が必須）。

| 用途 | 値 |
|---|---|
| network byte | mainnet `0x68` / testnet `0x98` |
| epoch adjustment（Timestamp の基準） | mainnet `1615853185`（UNIX秒） |
| generationHashSeed（署名に必須） | mainnet `57F7DA205008026C776CB6AED843393F04CD458E0AA2D9F1D5F31A402072B2D6`（取得: `GET /node/info`） |
| XYM mosaic id | `0x6BED913FA20223F8` |
| Transfer type | `0x4154` |
| AggregateComplete type | `0x4141` |
| AggregateBonded type | `0x4241` |
| （参考）MosaicDefinition / NamespaceRegistration / SecretLock / MultisigMod | `0x414D` / `0x414E` / `0x4152` / `0x4155` |
| TRANSACTION_VERSION（Transfer/Embedded） | `1`（Aggregate は `3` = AggregateCompleteV3） |
| fee multiplier（実務デフォルト） | `100` |
| cosignature 1件のサイズ | `104` byte（version8 + signer32 + signature64） |
| 通常Txの署名対象開始offset | `108` byte（通常Tx body開始offsetではない。Transfer等のbody開始は `128`） |
| Aggregate v3 署名対象の末尾 | ヘッダ後 `56` byte（v2系は `52`） |

message type byte: 平文 `0x00` / 暗号化 `0x01`。

## 最小 Transfer を1本組むバイト列順序

平文 Transfer（1アカウントが XYM を送る、モザイク1件・メッセージあり）の serialize 順:

```text
# --- header（署名前は signature をゼロ埋めで確保） ---
size                : uint32    # 全体byte長（最後に確定して書く）
reserved1           : uint32 = 0
signature           : 64 byte   # 署名前はゼロ、署名後に書き込む
signer_public_key   : 32 byte
reserved2           : uint32 = 0
# ここまでで offset 108。署名対象は次の version から始まる。
version             : uint8  = 1
network             : uint8  = 0x68
type                : uint16 = 0x4154        # little endian では 54 41
fee                 : uint64                 # multiplier * size（後で確定）
deadline            : uint64                 # ms since epoch
# ここまでで offset 128。TransferTransactionBody はここから始まる。
# --- TransferTransactionBody ---
recipient_address   : 24 byte                # UnresolvedAddress（実アドレスなら decoded 24 byte）
message_size        : uint16                 # type byte 込みの長さ
mosaics_count       : uint8  = 1
reserved_1          : uint8  = 0
reserved_2          : uint32 = 0
mosaics             : (mosaic_id uint64 || amount uint64) を mosaic_id 昇順に count 個
message             : message_size byte       # 先頭 0x00（平文）+ 本文
```

手順: ①signature をゼロ・fee を仮値で serialize → ②size を実長で確定して書き直し → ③fee を計算して書き直し →
④`generationHashSeed || serialized[108:]` を ed25519(SHA-512) で署名し signature に埋める →
**⑤（必須・PUT の前）`selftest()` を通す。固定入力でゴールデン `payload`/`tx_hash` と assert し、1 byte でも違えば止める** →
⑥hex 化して PUT。

②では **必ず実際に組み上げた `serialized.Length` をsize fieldに書く** こと（`size = 108 + body_size` は20 byte足りない誤り——「署名／ハッシュの対象バイト範囲（厳密）」節を参照）。

⑤は飛ばさないこと。serialize/offset/署名段のバグを、実 XYM を賭ける前にここで捕まえます（`selftest()` 本体と `deadline_ms` 引数化の詳細は「貼れる実装（ripemd160 フォールバック + selftest）」節を参照）。

## AggregateComplete で2つの Embedded Transfer を束ねる順序

```text
# --- Aggregate header（通常Txと同じ108 byteヘッダ） ---
size / reserved1 / signature / signer_public_key / reserved2
version = 3 / network / type = 0x4141 / fee / deadline
# --- AggregateTransactionBody ---
transactions_hash   : 32 byte                # 下の embedded 群の Merkle root
payload_size        : uint32                 # embedded 群の合計 byte長（8 byte alignment の padding 込み）
reserved            : uint32 = 0
transactions        : EmbeddedTransfer を順に並べる。各要素は8 byte境界に揃え、
                                             #   足りなければ 0x00 padding。末尾要素にも入れる
                                             #   （payload_size は padding 込み＝常に8の倍数になる）
cosignatures        : (version uint64 || signer 32 || signature 64) を連署者ごとに、body 末尾に並べる
```

Embedded Transfer は署名・fee・deadline を持たない（`size / embedded_reserved / signer / reserved / version / network / type / body`）。

手順: ①各 embedded を serialize（padなし）→ ②`leaf = SHA3-256(embedded_bytes)`、Merkle root を作り transactions_hash に →
③embedded 群を8 byte alignment で並べて payload_size 確定 → ④aggregate を size 仮・fee 仮で serialize →
⑤size 確定（**連署を付ける前**）→ ⑥`fee = 100 * (size_without_cosig + 104 * cosigner_count)` →
⑦`generationHashSeed || serialized[108:108+56]` を署名して outer signature に →
⑧aggregate tx hash を計算し、各連署者が **その hash に** ed25519 署名して cosignatures に追加、先頭 size を +104 ずつ更新 → ⑨PUT。
PUT の前に `selftest()` を `build_signed_aggregate` 付きで通し、`GOLDEN` の `agg_*` と照合します。

## まとめ

catbufferを読むときは、構文を難しく考えすぎず、「フィールドが上から順にlittle endianで並ぶ」と捉えると進めやすいです。

重要なのは、次の5点です。

- `inline` は展開。
- `make_const` は固定値。
- `make_reserved` は必ず指定値。
- `array` は count または byte length に従う。
- `@alignment` と `@sort_key` はserializerの義務。

この読み方ができれば、Symbol SDKがなくても、catbuffer schemaを根拠に任意のトランザクションを組み立てられます。
