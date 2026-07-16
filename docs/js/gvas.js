// GVAS (Unreal SaveGame) reader/writer.
// Faithful port of palworld-save-tools v0.24.0 archive.py + gvas.py (MIT,
// (c) cheahjs) to JavaScript. Property trees round-trip byte-identically.

const asciiDecoder = new TextDecoder("ascii");
const utf16Decoder = new TextDecoder("utf-16le");

export class UUID {
  /** @param {Uint8Array} rawBytes */
  constructor(rawBytes) {
    this.rawBytes = rawBytes;
    this._str = null;
  }

  static fromString(s) {
    const hex = s.replace(/-/g, "").toLowerCase();
    if (hex.length !== 32) throw new Error(`bad uuid string: ${s}`);
    const b = new Uint8Array(16);
    for (let i = 0; i < 16; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    // Microsoft mixed-endian reorder (same as palworld-save-tools UUID.from_str)
    const o = [3, 2, 1, 0, 7, 6, 5, 4, 11, 10, 9, 8, 15, 14, 13, 12];
    const ub = new Uint8Array(16);
    for (let i = 0; i < 16; i++) ub[i] = b[o[i]];
    return new UUID(ub);
  }

  toString() {
    if (this._str === null) {
      const b = this.rawBytes;
      const h = (n, w) => n.toString(16).padStart(w, "0");
      this._str =
        h(((b[3] << 24) | (b[2] << 16) | (b[1] << 8) | b[0]) >>> 0, 8) +
        "-" + h((b[7] << 8) | b[6], 4) +
        "-" + h((b[5] << 8) | b[4], 4) +
        "-" + h((b[11] << 8) | b[10], 4) +
        "-" + h((b[9] << 8) | b[8], 4) +
        h((((b[15] << 24) | (b[14] << 16) | (b[13] << 8) | b[12]) >>> 0), 8);
    }
    return this._str;
  }
}

export const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export class FReader {
  /**
   * @param {Uint8Array} data
   * @param {Record<string,string>} typeHints
   * @param {Record<string,{decode:Function,encode:Function}>} customProperties
   */
  constructor(data, typeHints = {}, customProperties = {}) {
    this.buf = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = 0;
    this.size = data.byteLength;
    this.typeHints = typeHints;
    this.customProperties = customProperties;
    this.warnings = [];
  }

  internalCopy(data) {
    return new FReader(data, this.typeHints, this.customProperties);
  }

  getTypeOr(path, dflt) {
    if (path in this.typeHints) return this.typeHints[path];
    this.warnings.push(`Struct type for ${path} not found, assuming ${dflt}`);
    return dflt;
  }

  eof() { return this.pos >= this.size; }
  read(n) { const r = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return r; }
  readToEnd() { return this.read(this.size - this.pos); }
  bool() { return this.byte() > 0; }
  byte() { return this.buf[this.pos++]; }
  byteList(n) { return this.read(n); }
  skip(n) { this.pos += n; }
  i16() { const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u16() { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i32() { const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  u32() { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  i64() { const v = this.view.getBigInt64(this.pos, true); this.pos += 8; return v; }
  u64() { const v = this.view.getBigUint64(this.pos, true); this.pos += 8; return v; }
  f32() { const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
  f64() { const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }
  guid() { return new UUID(this.read(16).slice()); }
  optionalGuid() { return this.byte() ? new UUID(this.read(16).slice()) : null; }

  fstring() {
    const size = this.i32();
    if (size === 0) return "";
    if (size < 0) {
      const n = -size;
      const data = this.read(n * 2).subarray(0, n * 2 - 2);
      return utf16Decoder.decode(data);
    }
    const data = this.read(size).subarray(0, size - 1);
    return asciiDecoder.decode(data);
  }

  tarray(fn) {
    const count = this.u32();
    const out = [];
    for (let i = 0; i < count; i++) out.push(fn(this));
    return out;
  }

  propertiesUntilEnd(path = "") {
    const properties = {};
    for (;;) {
      const name = this.fstring();
      if (name === "None") break;
      const typeName = this.fstring();
      const size = Number(this.u64());
      properties[name] = this.property(typeName, size, `${path}.${name}`);
    }
    return properties;
  }

  property(typeName, size, path, nestedCallerPath = "") {
    let value = {};
    if (path in this.customProperties && (path !== nestedCallerPath || nestedCallerPath === "")) {
      value = this.customProperties[path].decode(this, typeName, size, path);
      value.custom_type = path;
    } else if (typeName === "StructProperty") {
      value = this.struct(path);
    } else if (typeName === "IntProperty") {
      value = { id: this.optionalGuid(), value: this.i32() };
    } else if (typeName === "UInt16Property") {
      value = { id: this.optionalGuid(), value: this.u16() };
    } else if (typeName === "UInt32Property") {
      value = { id: this.optionalGuid(), value: this.u32() };
    } else if (typeName === "Int64Property") {
      value = { id: this.optionalGuid(), value: this.i64() };
    } else if (typeName === "FixedPoint64Property") {
      value = { id: this.optionalGuid(), value: this.i32() };
    } else if (typeName === "FloatProperty") {
      value = { id: this.optionalGuid(), value: this.f32() };
    } else if (typeName === "StrProperty") {
      value = { id: this.optionalGuid(), value: this.fstring() };
    } else if (typeName === "NameProperty") {
      value = { id: this.optionalGuid(), value: this.fstring() };
    } else if (typeName === "EnumProperty") {
      const enumType = this.fstring();
      const id = this.optionalGuid();
      const enumValue = this.fstring();
      value = { id, value: { type: enumType, value: enumValue } };
    } else if (typeName === "BoolProperty") {
      value = { value: this.bool(), id: this.optionalGuid() };
    } else if (typeName === "ByteProperty") {
      const enumType = this.fstring();
      const id = this.optionalGuid();
      const enumValue = enumType === "None" ? this.byte() : this.fstring();
      value = { id, value: { type: enumType, value: enumValue } };
    } else if (typeName === "ArrayProperty") {
      const arrayType = this.fstring();
      value = {
        array_type: arrayType,
        id: this.optionalGuid(),
        value: this.arrayProperty(arrayType, size - 4, path),
      };
    } else if (typeName === "MapProperty") {
      const keyType = this.fstring();
      const valueType = this.fstring();
      const id = this.optionalGuid();
      this.u32();
      const count = this.u32();
      const keyPath = path + ".Key";
      const keyStructType = keyType === "StructProperty" ? this.getTypeOr(keyPath, "Guid") : null;
      const valuePath = path + ".Value";
      const valueStructType = valueType === "StructProperty" ? this.getTypeOr(valuePath, "StructProperty") : null;
      const values = [];
      for (let i = 0; i < count; i++) {
        const key = this.propValue(keyType, keyStructType, keyPath);
        const val = this.propValue(valueType, valueStructType, valuePath);
        values.push({ key, value: val });
      }
      value = {
        key_type: keyType,
        value_type: valueType,
        key_struct_type: keyStructType,
        value_struct_type: valueStructType,
        id,
        value: values,
      };
    } else {
      throw new Error(`Unknown type: ${typeName} (${path})`);
    }
    value.type = typeName;
    return value;
  }

  propValue(typeName, structTypeName, path) {
    if (typeName === "StructProperty") return this.structValue(structTypeName, path);
    if (typeName === "EnumProperty") return this.fstring();
    if (typeName === "NameProperty") return this.fstring();
    if (typeName === "IntProperty") return this.i32();
    if (typeName === "BoolProperty") return this.bool();
    throw new Error(`Unknown property value type: ${typeName} (${path})`);
  }

  struct(path) {
    const structType = this.fstring();
    const structId = this.guid();
    const id = this.optionalGuid();
    const value = this.structValue(structType, path);
    return { struct_type: structType, struct_id: structId, id, value };
  }

  structValue(structType, path = "") {
    if (structType === "Vector") return { x: this.f64(), y: this.f64(), z: this.f64() };
    if (structType === "DateTime") return this.u64();
    if (structType === "Guid") return this.guid();
    if (structType === "Quat") return { x: this.f64(), y: this.f64(), z: this.f64(), w: this.f64() };
    if (structType === "LinearColor") return { r: this.f32(), g: this.f32(), b: this.f32(), a: this.f32() };
    return this.propertiesUntilEnd(path);
  }

  arrayProperty(arrayType, size, path) {
    const count = this.u32();
    if (arrayType === "StructProperty") {
      const propName = this.fstring();
      const propType = this.fstring();
      this.u64();
      const typeName = this.fstring();
      const id = this.guid();
      this.skip(1);
      const propValues = [];
      for (let i = 0; i < count; i++) {
        propValues.push(this.structValue(typeName, `${path}.${propName}`));
      }
      return { prop_name: propName, prop_type: propType, values: propValues, type_name: typeName, id };
    }
    return { values: this.arrayValue(arrayType, count, size, path) };
  }

  arrayValue(arrayType, count, size, path) {
    if (arrayType === "ByteProperty") {
      if (size === count) return this.byteList(count).slice();
      throw new Error("Labelled ByteProperty not implemented");
    }
    let fn;
    if (arrayType === "EnumProperty" || arrayType === "NameProperty") fn = () => this.fstring();
    else if (arrayType === "Guid") fn = () => this.guid();
    else throw new Error(`Unknown array type: ${arrayType} (${path})`);
    const values = [];
    for (let i = 0; i < count; i++) values.push(fn());
    return values;
  }
}

export class FWriter {
  constructor(customProperties = {}) {
    this.chunks = [];
    this.length = 0;
    this.customProperties = customProperties;
    this._scratch = new DataView(new ArrayBuffer(8));
  }

  copy() { return new FWriter(this.customProperties); }

  bytes() {
    const out = new Uint8Array(this.length);
    let off = 0;
    for (const c of this.chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  }

  write(data) {
    if (!(data instanceof Uint8Array)) data = Uint8Array.from(data);
    this.chunks.push(data);
    this.length += data.byteLength;
  }

  _num(setter, size, v) {
    const buf = new Uint8Array(size);
    const dv = new DataView(buf.buffer);
    setter.call(dv, 0, v, true);
    this.write(buf);
  }

  bool(v) { this.write(new Uint8Array([v ? 1 : 0])); }
  byte(v) { this.write(new Uint8Array([v & 0xff])); }
  u(v) { this.byte(v); }
  i16(v) { this._num(DataView.prototype.setInt16, 2, Number(v)); }
  u16(v) { this._num(DataView.prototype.setUint16, 2, Number(v)); }
  i32(v) { this._num(DataView.prototype.setInt32, 4, Number(v)); }
  u32(v) { this._num(DataView.prototype.setUint32, 4, Number(v)); }
  i64(v) { this._num(DataView.prototype.setBigInt64, 8, BigInt(v)); }
  u64(v) { this._num(DataView.prototype.setBigUint64, 8, BigInt(v)); }
  f32(v) { this._num(DataView.prototype.setFloat32, 4, v === null ? NaN : v); }
  f64(v) { this._num(DataView.prototype.setFloat64, 8, v === null ? NaN : v); }

  fstring(s) {
    const start = this.length;
    if (s === "") {
      this.i32(0);
    } else if (/^[\x00-\x7F]*$/.test(s)) {
      const bytes = new TextEncoder().encode(s);
      this.i32(bytes.length + 1);
      this.write(bytes);
      this.write(new Uint8Array([0]));
    } else {
      const units = [];
      for (let i = 0; i < s.length; i++) units.push(s.charCodeAt(i));
      const buf = new Uint8Array(units.length * 2);
      const dv = new DataView(buf.buffer);
      units.forEach((u, i) => dv.setUint16(i * 2, u, true));
      this.i32(-(units.length + 1));
      this.write(buf);
      this.write(new Uint8Array([0, 0]));
    }
    return this.length - start;
  }

  guid(u) {
    if (typeof u === "string") u = UUID.fromString(u);
    this.write(u.rawBytes);
  }

  optionalGuid(u) {
    if (u === null || u === undefined) { this.bool(false); return; }
    this.bool(true);
    this.guid(u);
  }

  tarray(fn, array) {
    this.u32(array.length);
    for (const item of array) fn(this, item);
  }

  properties(properties) {
    for (const key of Object.keys(properties)) {
      this.fstring(key);
      this.property(properties[key]);
    }
    this.fstring("None");
  }

  property(property) {
    this.fstring(property.type);
    const nested = this.copy();
    const size = nested.propertyInner(property.type, property);
    const buf = nested.bytes();
    this.u64(size);
    this.write(buf);
  }

  propertyInner(propertyType, property) {
    let size;
    if ("custom_type" in property) {
      if (property.custom_type in this.customProperties) {
        size = this.customProperties[property.custom_type].encode(this, propertyType, property);
      } else {
        throw new Error(`Unknown custom property type: ${property.custom_type}`);
      }
    } else if (propertyType === "StructProperty") {
      size = this.struct(property);
    } else if (propertyType === "IntProperty") {
      this.optionalGuid(property.id ?? null); this.i32(property.value); size = 4;
    } else if (propertyType === "UInt16Property") {
      this.optionalGuid(property.id ?? null); this.u16(property.value); size = 2;
    } else if (propertyType === "UInt32Property") {
      this.optionalGuid(property.id ?? null); this.u32(property.value); size = 4;
    } else if (propertyType === "Int64Property") {
      this.optionalGuid(property.id ?? null); this.i64(property.value); size = 8;
    } else if (propertyType === "FixedPoint64Property") {
      this.optionalGuid(property.id ?? null); this.i32(property.value); size = 4;
    } else if (propertyType === "FloatProperty") {
      this.optionalGuid(property.id ?? null); this.f32(property.value); size = 4;
    } else if (propertyType === "StrProperty") {
      this.optionalGuid(property.id ?? null); size = this.fstring(property.value);
    } else if (propertyType === "NameProperty") {
      this.optionalGuid(property.id ?? null); size = this.fstring(property.value);
    } else if (propertyType === "EnumProperty") {
      this.fstring(property.value.type);
      this.optionalGuid(property.id ?? null);
      size = this.fstring(property.value.value);
    } else if (propertyType === "BoolProperty") {
      this.bool(property.value);
      this.optionalGuid(property.id ?? null);
      size = 0;
    } else if (propertyType === "ByteProperty") {
      this.fstring(property.value.type);
      this.optionalGuid(property.id ?? null);
      if (property.value.type === "None") { this.byte(property.value.value); size = 1; }
      else size = this.fstring(property.value.value);
    } else if (propertyType === "ArrayProperty") {
      this.fstring(property.array_type);
      this.optionalGuid(property.id ?? null);
      const arrayWriter = this.copy();
      arrayWriter.arrayProperty(property.array_type, property.value);
      const buf = arrayWriter.bytes();
      size = buf.byteLength;
      this.write(buf);
    } else if (propertyType === "MapProperty") {
      this.fstring(property.key_type);
      this.fstring(property.value_type);
      this.optionalGuid(property.id ?? null);
      const mapWriter = this.copy();
      mapWriter.u32(0);
      mapWriter.u32(property.value.length);
      for (const entry of property.value) {
        mapWriter.propValue(property.key_type, property.key_struct_type, entry.key);
        mapWriter.propValue(property.value_type, property.value_struct_type, entry.value);
      }
      const buf = mapWriter.bytes();
      size = buf.byteLength;
      this.write(buf);
    } else {
      throw new Error(`Unknown property type: ${propertyType}`);
    }
    return size;
  }

  struct(property) {
    this.fstring(property.struct_type);
    this.guid(property.struct_id);
    this.optionalGuid(property.id ?? null);
    const start = this.length;
    this.structValue(property.struct_type, property.value);
    return this.length - start;
  }

  structValue(structType, value) {
    if (structType === "Vector") { this.f64(value.x); this.f64(value.y); this.f64(value.z); }
    else if (structType === "DateTime") this.u64(value);
    else if (structType === "Guid") this.guid(value);
    else if (structType === "Quat") { this.f64(value.x); this.f64(value.y); this.f64(value.z); this.f64(value.w); }
    else if (structType === "LinearColor") { this.f32(value.r); this.f32(value.g); this.f32(value.b); this.f32(value.a); }
    else this.properties(value);
  }

  propValue(typeName, structTypeName, value) {
    if (typeName === "StructProperty") this.structValue(structTypeName, value);
    else if (typeName === "EnumProperty") this.fstring(value);
    else if (typeName === "NameProperty") this.fstring(value);
    else if (typeName === "IntProperty") this.i32(value);
    else if (typeName === "BoolProperty") this.bool(value);
    else throw new Error(`Unknown property value type: ${typeName}`);
  }

  arrayProperty(arrayType, value) {
    const count = value.values.length;
    this.u32(count);
    if (arrayType === "StructProperty") {
      this.fstring(value.prop_name);
      this.fstring(value.prop_type);
      const nested = this.copy();
      for (let i = 0; i < count; i++) nested.structValue(value.type_name, value.values[i]);
      const buf = nested.bytes();
      this.u64(buf.byteLength);
      this.fstring(value.type_name);
      this.guid(value.id);
      this.u(0);
      this.write(buf);
    } else {
      this.arrayValue(arrayType, count, value.values);
    }
  }

  arrayValue(arrayType, count, values) {
    if (arrayType === "ByteProperty" && values instanceof Uint8Array) {
      this.write(values);
      return;
    }
    for (let i = 0; i < count; i++) {
      const v = values[i];
      if (arrayType === "IntProperty") this.i32(v);
      else if (arrayType === "UInt32Property") this.u32(v);
      else if (arrayType === "Int64Property") this.i64(v);
      else if (arrayType === "FloatProperty") this.f32(v);
      else if (arrayType === "StrProperty") this.fstring(v);
      else if (arrayType === "NameProperty") this.fstring(v);
      else if (arrayType === "EnumProperty") this.fstring(v);
      else if (arrayType === "BoolProperty") this.bool(v);
      else if (arrayType === "ByteProperty") this.byte(v);
      else throw new Error(`Unknown array type: ${arrayType}`);
    }
  }
}

export class GvasHeader {
  static read(reader) {
    const h = new GvasHeader();
    h.magic = reader.i32();
    if (h.magic !== 0x53415647) throw new Error("invalid magic");
    h.save_game_version = reader.i32();
    if (h.save_game_version !== 3) throw new Error(`expected save game version 3, got ${h.save_game_version}`);
    h.package_file_version_ue4 = reader.i32();
    h.package_file_version_ue5 = reader.i32();
    h.engine_version_major = reader.u16();
    h.engine_version_minor = reader.u16();
    h.engine_version_patch = reader.u16();
    h.engine_version_changelist = reader.u32();
    h.engine_version_branch = reader.fstring();
    h.custom_version_format = reader.i32();
    if (h.custom_version_format !== 3) throw new Error(`expected custom version format 3, got ${h.custom_version_format}`);
    h.custom_versions = reader.tarray((r) => [r.guid(), r.i32()]);
    h.save_game_class_name = reader.fstring();
    return h;
  }

  write(writer) {
    writer.i32(this.magic);
    writer.i32(this.save_game_version);
    writer.i32(this.package_file_version_ue4);
    writer.i32(this.package_file_version_ue5);
    writer.u16(this.engine_version_major);
    writer.u16(this.engine_version_minor);
    writer.u16(this.engine_version_patch);
    writer.u32(this.engine_version_changelist);
    writer.fstring(this.engine_version_branch);
    writer.i32(this.custom_version_format);
    writer.tarray((w, v) => { w.guid(v[0]); w.i32(v[1]); }, this.custom_versions);
    writer.fstring(this.save_game_class_name);
  }
}

export class GvasFile {
  static read(data, typeHints = {}, customProperties = {}) {
    const g = new GvasFile();
    const reader = new FReader(data, typeHints, customProperties);
    g.header = GvasHeader.read(reader);
    g.properties = reader.propertiesUntilEnd();
    g.trailer = reader.readToEnd().slice();
    g.warnings = reader.warnings;
    return g;
  }

  write(customProperties = {}) {
    const writer = new FWriter(customProperties);
    this.header.write(writer);
    writer.properties(this.properties);
    writer.write(this.trailer);
    return writer.bytes();
  }
}

// Type hints from palworld-save-tools paltypes.py
export const PALWORLD_TYPE_HINTS = {
  ".worldSaveData.CharacterContainerSaveData.Key": "StructProperty",
  ".worldSaveData.CharacterSaveParameterMap.Key": "StructProperty",
  ".worldSaveData.CharacterSaveParameterMap.Value": "StructProperty",
  ".worldSaveData.FoliageGridSaveDataMap.Key": "StructProperty",
  ".worldSaveData.FoliageGridSaveDataMap.Value.ModelMap.Value": "StructProperty",
  ".worldSaveData.FoliageGridSaveDataMap.Value.ModelMap.Value.InstanceDataMap.Key": "StructProperty",
  ".worldSaveData.FoliageGridSaveDataMap.Value.ModelMap.Value.InstanceDataMap.Value": "StructProperty",
  ".worldSaveData.FoliageGridSaveDataMap.Value": "StructProperty",
  ".worldSaveData.ItemContainerSaveData.Key": "StructProperty",
  ".worldSaveData.MapObjectSaveData.MapObjectSaveData.ConcreteModel.ModuleMap.Value": "StructProperty",
  ".worldSaveData.MapObjectSaveData.MapObjectSaveData.Model.EffectMap.Value": "StructProperty",
  ".worldSaveData.MapObjectSpawnerInStageSaveData.Key": "StructProperty",
  ".worldSaveData.MapObjectSpawnerInStageSaveData.Value": "StructProperty",
  ".worldSaveData.MapObjectSpawnerInStageSaveData.Value.SpawnerDataMapByLevelObjectInstanceId.Key": "Guid",
  ".worldSaveData.MapObjectSpawnerInStageSaveData.Value.SpawnerDataMapByLevelObjectInstanceId.Value": "StructProperty",
  ".worldSaveData.MapObjectSpawnerInStageSaveData.Value.SpawnerDataMapByLevelObjectInstanceId.Value.ItemMap.Value": "StructProperty",
  ".worldSaveData.WorkSaveData.WorkSaveData.WorkAssignMap.Value": "StructProperty",
  ".worldSaveData.BaseCampSaveData.Key": "Guid",
  ".worldSaveData.BaseCampSaveData.Value": "StructProperty",
  ".worldSaveData.BaseCampSaveData.Value.ModuleMap.Value": "StructProperty",
  ".worldSaveData.ItemContainerSaveData.Value": "StructProperty",
  ".worldSaveData.CharacterContainerSaveData.Value": "StructProperty",
  ".worldSaveData.GroupSaveDataMap.Key": "Guid",
  ".worldSaveData.GroupSaveDataMap.Value": "StructProperty",
  ".worldSaveData.EnemyCampSaveData.EnemyCampStatusMap.Value": "StructProperty",
  ".worldSaveData.DungeonSaveData.DungeonSaveData.MapObjectSaveData.MapObjectSaveData.Model.EffectMap.Value": "StructProperty",
  ".worldSaveData.DungeonSaveData.DungeonSaveData.MapObjectSaveData.MapObjectSaveData.ConcreteModel.ModuleMap.Value": "StructProperty",
  ".worldSaveData.InvaderSaveData.Key": "Guid",
  ".worldSaveData.InvaderSaveData.Value": "StructProperty",
  ".worldSaveData.OilrigSaveData.OilrigMap.Value": "StructProperty",
  ".worldSaveData.SupplySaveData.SupplyInfos.Key": "Guid",
  ".worldSaveData.SupplySaveData.SupplyInfos.Value": "StructProperty",
};
