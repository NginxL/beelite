// 文件写入工具：保证每个数据块被完整写入，短写会继续写剩余部分，0 字节写入视为失败。
import type { FileHandle } from 'node:fs/promises';

export type WriteFn = (fh: FileHandle, buf: Uint8Array, offset: number, length: number) => Promise<{ bytesWritten: number }>;

/** 可替换的底层写入与 fsync 实现（测试用来注入短写 / 0 写 / fsync 失败） */
export const io: { write: WriteFn; sync: (fh: FileHandle) => Promise<void> } = {
  write: (fh, buf, offset, length) => fh.write(buf, offset, length),
  sync: (fh) => fh.sync(),
};

export async function writeAll(fh: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await io.write(fh, chunk, offset, chunk.byteLength - offset);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > chunk.byteLength - offset) {
      throw new Error('写入文件失败（没有写入任何数据）');
    }
    offset += bytesWritten;
  }
}
