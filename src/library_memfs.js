// Copyright 2013 The Emscripten Authors.  All rights reserved.
// Emscripten is available under two separate licenses, the MIT license and the
// University of Illinois/NCSA Open Source License.  Both these licenses can be
// found in the LICENSE file.

mergeInto(LibraryManager.library, {
  $MEMFS__deps: ['$FS'],
  $MEMFS: {
    ops_table: null,
    mount: function(mount) {
      return MEMFS.createNode(null, '/', {{{ cDefine('S_IFDIR') }}} | 511 /* 0777 */, 0);
    },
    createNode: function(parent, name, mode, dev) {
      if (FS.isBlkdev(mode) || FS.isFIFO(mode)) {
        // no supported
        throw new FS.ErrnoError({{{ cDefine('EPERM') }}});
      }
      if (!MEMFS.ops_table) {
        MEMFS.ops_table = {
          dir: {
            node: {
              getattr: MEMFS.node_ops.getattr,
              setattr: MEMFS.node_ops.setattr,
              lookup: MEMFS.node_ops.lookup,
              mknod: MEMFS.node_ops.mknod,
              rename: MEMFS.node_ops.rename,
              unlink: MEMFS.node_ops.unlink,
              rmdir: MEMFS.node_ops.rmdir,
              readdir: MEMFS.node_ops.readdir,
              symlink: MEMFS.node_ops.symlink
            },
            stream: {
              llseek: MEMFS.stream_ops.llseek
            }
          },
          file: {
            node: {
              getattr: MEMFS.node_ops.getattr,
              setattr: MEMFS.node_ops.setattr
            },
            stream: {
              llseek: MEMFS.stream_ops.llseek,
              read: MEMFS.stream_ops.read,
              write: MEMFS.stream_ops.write,
              allocate: MEMFS.stream_ops.allocate,
              mmap: MEMFS.stream_ops.mmap,
              msync: MEMFS.stream_ops.msync
            }
          },
          link: {
            node: {
              getattr: MEMFS.node_ops.getattr,
              setattr: MEMFS.node_ops.setattr,
              readlink: MEMFS.node_ops.readlink
            },
            stream: {}
          },
          chrdev: {
            node: {
              getattr: MEMFS.node_ops.getattr,
              setattr: MEMFS.node_ops.setattr
            },
            stream: FS.chrdev_stream_ops
          }
        };
      }
      var node = FS.createNode(parent, name, mode, dev);
      if (FS.isDir(node.mode)) {
        node.node_ops = MEMFS.ops_table.dir.node;
        node.stream_ops = MEMFS.ops_table.dir.stream;
        node.contents = {};
      } else if (FS.isFile(node.mode)) {
        node.node_ops = MEMFS.ops_table.file.node;
        node.stream_ops = MEMFS.ops_table.file.stream;
        node.usedBytes = 0; // The actual number of bytes used in the typed array, as opposed to contents.length which gives the whole capacity.
        // When the byte data of the file is populated, this will point to either a typed array, or a normal JS array. Typed arrays are preferred
        // for performance, and used by default. However, typed arrays are not resizable like normal JS arrays are, so there is a small disk size
        // penalty involved for appending file writes that continuously grow a file similar to std::vector capacity vs used -scheme.
        node.contents = null; 
      } else if (FS.isLink(node.mode)) {
        node.node_ops = MEMFS.ops_table.link.node;
        node.stream_ops = MEMFS.ops_table.link.stream;
      } else if (FS.isChrdev(node.mode)) {
        node.node_ops = MEMFS.ops_table.chrdev.node;
        node.stream_ops = MEMFS.ops_table.chrdev.stream;
      }
      node.timestamp = Date.now();
      // add the new node to the parent
      if (parent) {
        parent.contents[name] = node;
      }
      return node;
    },

    // Given a file node, returns its file data converted to a regular JS array. You should treat this as read-only.
    getFileDataAsRegularArray: function(node) {
      if (node.contents && node.contents.subarray) {
        var arr = [];
        for (var i = 0; i < node.usedBytes; ++i) arr.push(node.contents[i]);
        return arr; // Returns a copy of the original data.
      }
      return node.contents; // No-op, the file contents are already in a JS array. Return as-is.
    },

    // Given a file node, returns its file data converted to a typed array.
    getFileDataAsTypedArray: function(node) {
      if (!node.contents) return new Uint8Array;
      if (node.contents.subarray) return node.contents.subarray(0, node.usedBytes); // Make sure to not return excess unused bytes.
      return new Uint8Array(node.contents);
    },

    // Allocates a new backing store for the given node so that it can fit at least newSize amount of bytes.
    // May allocate more, to provide automatic geometric increase and amortized linear performance appending writes.
    // Never shrinks the storage.
    expandFileStorage: function(node, newCapacity) {
      var prevCapacity = node.contents ? node.contents.length : 0;
      if (prevCapacity >= newCapacity) return; // No need to expand, the storage was already large enough.
      // Don't expand strictly to the given requested limit if it's only a very small increase, but instead geometrically grow capacity.
      // For small filesizes (<1MB), perform size*2 geometric increase, but for large sizes, do a much more conservative size*1.125 increase to
      // avoid overshooting the allocation cap by a very large margin.
      var CAPACITY_DOUBLING_MAX = 1024 * 1024;
      newCapacity = Math.max(newCapacity, (prevCapacity * (prevCapacity < CAPACITY_DOUBLING_MAX ? 2.0 : 1.125)) | 0);
      if (prevCapacity != 0) newCapacity = Math.max(newCapacity, 256); // At minimum allocate 256b for each file when expanding.
      var oldContents = node.contents;
      node.contents = new Uint8Array(newCapacity); // Allocate new storage.
      if (node.usedBytes > 0) node.contents.set(oldContents.subarray(0, node.usedBytes), 0); // Copy old data over to the new storage.
      return;
    },

    // Performs an exact resize of the backing file storage to the given size, if the size is not exactly this, the storage is fully reallocated.
    resizeFileStorage: function(node, newSize) {
      if (node.usedBytes == newSize) return;
      if (newSize == 0) {
        node.contents = null; // Fully decommit when requesting a resize to zero.
        node.usedBytes = 0;
        return;
      }
      if (!node.contents || node.contents.subarray) { // Resize a typed array if that is being used as the backing store.
        var oldContents = node.contents;
        node.contents = new Uint8Array(new ArrayBuffer(newSize)); // Allocate new storage.
        if (oldContents) {
          node.contents.set(oldContents.subarray(0, Math.min(newSize, node.usedBytes))); // Copy old data over to the new storage.
        }
        node.usedBytes = newSize;
        return;
      }
      // Backing with a JS array.
      if (!node.contents) node.contents = [];
      if (node.contents.length > newSize) node.contents.length = newSize;
      else while (node.contents.length < newSize) node.contents.push(0);
      node.usedBytes = newSize;
    },

    node_ops: {
      getattr: function(node) {
        var attr = {};
        // device numbers reuse inode numbers.
        attr.dev = FS.isChrdev(node.mode) ? node.id : 1;
        attr.ino = node.id;
        attr.mode = node.mode;
        attr.nlink = 1;
        attr.uid = 0;
        attr.gid = 0;
        attr.rdev = node.rdev;
        if (FS.isDir(node.mode)) {
          attr.size = 4096;
        } else if (FS.isFile(node.mode)) {
          attr.size = node.usedBytes;
        } else if (FS.isLink(node.mode)) {
          attr.size = node.link.length;
        } else {
          attr.size = 0;
        }
        attr.atime = new Date(node.timestamp);
        attr.mtime = new Date(node.timestamp);
        attr.ctime = new Date(node.timestamp);
        // NOTE: In our implementation, st_blocks = Math.ceil(st_size/st_blksize),
        //       but this is not required by the standard.
        attr.blksize = 4096;
        attr.blocks = Math.ceil(attr.size / attr.blksize);
        return attr;
      },
      setattr: function(node, attr) {
        if (attr.mode !== undefined) {
          node.mode = attr.mode;
        }
        if (attr.timestamp !== undefined) {
          node.timestamp = attr.timestamp;
        }
        if (attr.size !== undefined) {
          MEMFS.resizeFileStorage(node, attr.size);
        }
      },
      lookup: function(parent, name) {
        throw FS.genericErrors[{{{ cDefine('ENOENT') }}}];
      },
      mknod: function(parent, name, mode, dev) {
        return MEMFS.createNode(parent, name, mode, dev);
      },
      rename: function(old_node, new_dir, new_name) {
        // if we're overwriting a directory at new_name, make sure it's empty.
        if (FS.isDir(old_node.mode)) {
          var new_node;
          try {
            new_node = FS.lookupNode(new_dir, new_name);
          } catch (e) {
          }
          if (new_node) {
            for (var i in new_node.contents) {
              throw new FS.ErrnoError({{{ cDefine('ENOTEMPTY') }}});
            }
          }
        }
        // do the internal rewiring
        delete old_node.parent.contents[old_node.name];
        old_node.name = new_name;
        new_dir.contents[new_name] = old_node;
        old_node.parent = new_dir;
      },
      unlink: function(parent, name) {
        delete parent.contents[name];
      },
      rmdir: function(parent, name) {
        var node = FS.lookupNode(parent, name);
        for (var i in node.contents) {
          throw new FS.ErrnoError({{{ cDefine('ENOTEMPTY') }}});
        }
        delete parent.contents[name];
      },
      readdir: function(node) {
        var entries = ['.', '..'];
        for (var key in node.contents) {
          if (!node.contents.hasOwnProperty(key)) {
            continue;
          }
          entries.push(key);
        }
        return entries;
      },
      symlink: function(parent, newname, oldpath) {
        var node = MEMFS.createNode(parent, newname, 511 /* 0777 */ | {{{ cDefine('S_IFLNK') }}}, 0);
        node.link = oldpath;
        return node;
      },
      readlink: function(node) {
        if (!FS.isLink(node.mode)) {
          throw new FS.ErrnoError({{{ cDefine('EINVAL') }}});
        }
        return node.link;
      },
    },
    stream_ops: {
      read: function(stream, buffer, offset, length, position) {
        var contents = stream.node.contents;
        if (position >= stream.node.usedBytes) return 0;
        var size = Math.min(stream.node.usedBytes - position, length);
#if ASSERTIONS
        assert(size >= 0);
#endif
        if (size > 8 && contents.subarray) { // non-trivial, and typed array
          buffer.set(contents.subarray(position, position + size), offset);
        } else {
          for (var i = 0; i < size; i++) buffer[offset + i] = contents[position + i];
        }
        return size;
      },

      // Writes the byte range (buffer[offset], buffer[offset+length]) to offset 'position' into the file pointed by 'stream'
      // canOwn: A boolean that tells if this function can take ownership of the passed in buffer from the subbuffer portion
      //         that the typed array view 'buffer' points to. The underlying ArrayBuffer can be larger than that, but
      //         canOwn=true will not take ownership of the portion outside the bytes addressed by the view. This means that
      //         with canOwn=true, creating a copy of the bytes is avoided, but the caller shouldn't touch the passed in range
      //         of bytes anymore since their contents now represent file data inside the filesystem.
      write: function(stream, buffer, offset, length, position, canOwn) {
#if ALLOW_MEMORY_GROWTH
        // If memory can grow, we don't want to hold on to references of
        // the memory Buffer, as they may get invalidated. That means
        // we need to do a copy here.
#if ASSERTIONS
        // FIXME: this is inefficient as the file packager may have
        //        copied the data into memory already - we may want to
        //        integrate more there and let the file packager loading
        //        code be able to query if memory growth is on or off.
        if (canOwn) {
          warnOnce('file packager has copied file data into memory, but in memory growth we are forced to copy it again (see --no-heap-copy)');
        }
#endif // ASSERTIONS
        canOwn = false;
#endif // ALLOW_MEMORY_GROWTH

        if (!length) return 0;
        var node = stream.node;
        node.timestamp = Date.now();

        if (buffer.subarray && (!node.contents || node.contents.subarray)) { // This write is from a typed array to a typed array?
          if (canOwn) {
#if ASSERTIONS
            assert(position === 0, 'canOwn must imply no weird position inside the file');
#endif
            node.contents = buffer.subarray(offset, offset + length);
            node.usedBytes = length;
            return length;
          } else if (node.usedBytes === 0 && position === 0) { // If this is a simple first write to an empty file, do a fast set since we don't need to care about old data.
            node.contents = new Uint8Array(buffer.subarray(offset, offset + length));
            node.usedBytes = length;
            return length;
          } else if (position + length <= node.usedBytes) { // Writing to an already allocated and used subrange of the file?
            node.contents.set(buffer.subarray(offset, offset + length), position);
            return length;
          }
        }

        // Appending to an existing file and we need to reallocate, or source data did not come as a typed array.
        MEMFS.expandFileStorage(node, position+length);
        if (node.contents.subarray && buffer.subarray) node.contents.set(buffer.subarray(offset, offset + length), position); // Use typed array write if available.
        else {
          for (var i = 0; i < length; i++) {
           node.contents[position + i] = buffer[offset + i]; // Or fall back to manual write if not.
          }
        }
        node.usedBytes = Math.max(node.usedBytes, position+length);
        return length;
      },

      llseek: function(stream, offset, whence) {
        var position = offset;
        if (whence === {{{ cDefine('SEEK_CUR') }}}) {
          position += stream.position;
        } else if (whence === {{{ cDefine('SEEK_END') }}}) {
          if (FS.isFile(stream.node.mode)) {
            position += stream.node.usedBytes;
          }
        }
        if (position < 0) {
          throw new FS.ErrnoError({{{ cDefine('EINVAL') }}});
        }
        return position;
      },
      allocate: function(stream, offset, length) {
        MEMFS.expandFileStorage(stream.node, offset + length);
        stream.node.usedBytes = Math.max(stream.node.usedBytes, offset + length);
      },
      mmap: function(stream, buffer, offset, length, position, prot, flags) {
        if (!FS.isFile(stream.node.mode)) {
          throw new FS.ErrnoError({{{ cDefine('ENODEV') }}});
        }
        var ptr;
        var allocated;
        var contents = stream.node.contents;
        // Only make a new copy when MAP_PRIVATE is specified.
        if ( !(flags & {{{ cDefine('MAP_PRIVATE') }}}) &&
              (contents.buffer === buffer || contents.buffer === buffer.buffer) ) {
          // We can't emulate MAP_SHARED when the file is not backed by the buffer
          // we're mapping to (e.g. the HEAP buffer).
          allocated = false;
          ptr = contents.byteOffset;
        } else {
          // Try to avoid unnecessary slices.
          if (position > 0 || position + length < stream.node.usedBytes) {
            if (contents.subarray) {
              contents = contents.subarray(position, position + length);
            } else {
              contents = Array.prototype.slice.call(contents, position, position + length);
            }
          }
          allocated = true;
          // malloc() can lead to growing the heap. If targeting the heap, we need to
          // re-acquire the heap buffer object in case growth had occurred.
          var fromHeap = (buffer.buffer == HEAP8.buffer);
          ptr = _malloc(length);
          if (!ptr) {
            throw new FS.ErrnoError({{{ cDefine('ENOMEM') }}});
          }
          (fromHeap ? HEAP8 : buffer).set(contents, ptr);
        }
        return { ptr: ptr, allocated: allocated };
      },
      msync: function(stream, buffer, offset, length, mmapFlags) {
        if (!FS.isFile(stream.node.mode)) {
          throw new FS.ErrnoError({{{ cDefine('ENODEV') }}});
        }
        if (mmapFlags & {{{ cDefine('MAP_PRIVATE') }}}) {
          // MAP_PRIVATE calls need not to be synced back to underlying fs
          return 0;
        }

        var bytesWritten = MEMFS.stream_ops.write(stream, buffer, 0, length, offset, false);
        // should we check if bytesWritten and length are the same?
        return 0;
      }
    }
  }
});

