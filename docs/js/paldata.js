// Palworld custom property parsers — only the two needed for migration and
// verified (against real 1.0 saves) to round-trip byte-identically:
//  - CharacterSaveParameterMap value blobs (players + pals)
//  - CharacterContainerSaveData slot blobs (party / palbox / base containers)
// Ports of the hardened parsers from quadrantbs/palworld-hostfix-toolkit
// (trailing-bytes preservation + raw fallback), themselves based on
// palworld-save-tools (MIT).
// Everything else in Level.sav is intentionally kept as opaque raw bytes.

import { FWriter } from "./gvas.js";

export const character = {
  decode(reader, typeName, size, path) {
    if (typeName !== "ArrayProperty") throw new Error(`Expected ArrayProperty, got ${typeName}`);
    const value = reader.property(typeName, size, path, path);
    try {
      value.value = character.decodeBytes(reader, value.value.values);
    } catch (e) {
      reader.warnings.push(`failed to decode ${path}, keeping raw bytes: ${e.message}`);
    }
    return value;
  },

  decodeBytes(parentReader, charBytes) {
    const reader = parentReader.internalCopy(
      charBytes instanceof Uint8Array ? charBytes : Uint8Array.from(charBytes)
    );
    const charData = {
      object: reader.propertiesUntilEnd(),
      unknown_bytes: reader.byteList(4).slice(),
      group_id: reader.guid(),
    };
    if (!reader.eof()) charData.trailing_bytes = reader.readToEnd().slice();
    return charData;
  },

  encode(writer, propertyType, property) {
    if (propertyType !== "ArrayProperty") throw new Error(`Expected ArrayProperty, got ${propertyType}`);
    delete property.custom_type;
    if (!("values" in property.value)) {
      const encoded = character.encodeBytes(property.value);
      property.value = { values: encoded };
    }
    return writer.propertyInner(propertyType, property);
  },

  encodeBytes(p) {
    const writer = new FWriter();
    writer.properties(p.object);
    writer.write(p.unknown_bytes);
    writer.guid(p.group_id);
    if ("trailing_bytes" in p) writer.write(p.trailing_bytes);
    return writer.bytes();
  },
};

export const characterContainer = {
  decode(reader, typeName, size, path) {
    if (typeName !== "ArrayProperty") throw new Error(`Expected ArrayProperty, got ${typeName}`);
    const value = reader.property(typeName, size, path, path);
    try {
      value.value = characterContainer.decodeBytes(reader, value.value.values);
    } catch (e) {
      reader.warnings.push(`failed to decode ${path}, keeping raw bytes: ${e.message}`);
    }
    return value;
  },

  decodeBytes(parentReader, cBytes) {
    if (cBytes.length === 0) return null;
    const reader = parentReader.internalCopy(
      cBytes instanceof Uint8Array ? cBytes : Uint8Array.from(cBytes)
    );
    const data = {
      player_uid: reader.guid(),
      instance_id: reader.guid(),
      permission_tribe_id: reader.byte(),
    };
    if (!reader.eof()) data.trailing_bytes = reader.readToEnd().slice();
    return data;
  },

  encode(writer, propertyType, property) {
    if (propertyType !== "ArrayProperty") throw new Error(`Expected ArrayProperty, got ${propertyType}`);
    delete property.custom_type;
    if (!("values" in property.value)) {
      const encoded = characterContainer.encodeBytes(property.value);
      property.value = { values: encoded };
    }
    return writer.propertyInner(propertyType, property);
  },

  encodeBytes(p) {
    if (p === null) return new Uint8Array(0);
    const writer = new FWriter();
    writer.guid(p.player_uid);
    writer.guid(p.instance_id);
    writer.byte(p.permission_tribe_id);
    if ("trailing_bytes" in p) writer.write(p.trailing_bytes);
    return writer.bytes();
  },
};

// The selective set verified to round-trip Level.sav byte-identically.
export const LEVEL_CUSTOM_PROPERTIES = {
  ".worldSaveData.CharacterSaveParameterMap.Value.RawData": character,
  ".worldSaveData.CharacterContainerSaveData.Value.Slots.Slots.RawData": characterContainer,
};
