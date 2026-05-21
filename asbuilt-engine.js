(() => {
  "use strict";

  const IFC_GUID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

  function localName(node) {
    return String(node?.localName || node?.nodeName || "").replace(/^.*:/, "");
  }

  function directText(element, name) {
    for (const child of Array.from(element?.children || [])) {
      if (localName(child) === name) return String(child.textContent || "").trim();
    }
    return "";
  }

  function parseNumber(value) {
    const num = Number.parseFloat(String(value || "").replace(",", "."));
    return Number.isFinite(num) ? num : null;
  }

  function childByName(element, name) {
    return Array.from(element?.children || []).find((child) => localName(child) === name) || null;
  }

  function parseGrid(element) {
    const grid = childByName(element, "ComputedGrid") || childByName(element, "Grid") || element;
    const east = parseNumber(directText(grid, "East"));
    const north = parseNumber(directText(grid, "North"));
    const elevation = parseNumber(directText(grid, "Elevation"));
    if (east == null || north == null || elevation == null) return null;
    return [east, north, elevation];
  }

  function collectProps(element) {
    const props = {};
    for (const node of Array.from(element?.querySelectorAll("*") || [])) {
      const tag = localName(node);
      let name = null;
      let value = null;
      if (tag === "Field") {
        name = node.getAttribute("Name");
        value = node.getAttribute("Value");
      } else if (tag === "Attribute") {
        name = directText(node, "Name");
        value = directText(node, "Value");
      }
      if (name && value != null && props[name] == null) props[name] = String(value);
    }
    return props;
  }

  function normalizePointName(name) {
    return String(name || "").trim();
  }

  function parseJxl(jxlText) {
    const xml = String(jxlText || "");
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const activeMapFiles = Array.from(doc.querySelectorAll("*"))
      .filter((node) => localName(node) === "File")
      .map((node) => String(node.textContent || "").trim())
      .filter((name) => /\.ifc$/i.test(name));

    const objects = new Map();
    const pointRecordsByGuid = new Map();

    for (const record of Array.from(doc.querySelectorAll("*")).filter((node) => localName(node) === "PointRecord")) {
      const props = collectProps(record);
      const guid = props.GUID || props.IfcGuid || props.IFC_GUID || null;
      const name = normalizePointName(directText(record, "Name") || record.getAttribute("ID"));
      const coord = parseGrid(record);
      if (!guid || !name || !coord) continue;
      if (!pointRecordsByGuid.has(guid)) pointRecordsByGuid.set(guid, new Map());
      const byName = pointRecordsByGuid.get(guid);
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({ name, coord, props });
    }

    for (const point of Array.from(doc.querySelectorAll("*")).filter((node) => localName(node) === "Point")) {
      const props = collectProps(point);
      const guid = props.GUID || props.IfcGuid || props.IFC_GUID || null;
      const name = normalizePointName(directText(point, "Name") || point.getAttribute("ID"));
      const coord = parseGrid(point);
      if (!guid || !name || !coord) continue;
      if (!objects.has(guid)) {
        objects.set(guid, {
          guid,
          design: {},
          measured: {},
          props: {},
          pointOrder: [],
          activeMapFiles: [...activeMapFiles],
          stakeoutMethod: null,
          lineName: null
        });
      }
      const object = objects.get(guid);
      object.design[name] = coord;
      object.props = { ...object.props, ...props };
      if (!object.pointOrder.includes(name)) object.pointOrder.push(name);
    }

    for (const [guid, byName] of pointRecordsByGuid.entries()) {
      if (!objects.has(guid)) {
        objects.set(guid, {
          guid,
          design: {},
          measured: {},
          props: {},
          pointOrder: [],
          activeMapFiles: [...activeMapFiles],
          stakeoutMethod: null,
          lineName: null
        });
      }
      const object = objects.get(guid);
      for (const [name, records] of byName.entries()) {
        const last = records[records.length - 1];
        if (!object.design[name] && records.length > 1) object.design[name] = records[0].coord;
        object.measured[name] = last.coord;
        object.props = { ...object.props, ...last.props };
        if (!object.pointOrder.includes(name)) object.pointOrder.push(name);
      }
    }

    for (const polyline of Array.from(doc.querySelectorAll("*")).filter((node) => localName(node) === "LivePolylineRecord")) {
      const props = collectProps(polyline);
      const guid = props.GUID || props.IfcGuid || props.IFC_GUID || null;
      if (!guid) continue;
      if (!objects.has(guid)) {
        objects.set(guid, {
          guid,
          design: {},
          measured: {},
          props: {},
          pointOrder: [],
          activeMapFiles: [...activeMapFiles],
          stakeoutMethod: null,
          lineName: null
        });
      }
      const object = objects.get(guid);
      object.props = { ...object.props, ...props };
      object.stakeoutMethod = directText(polyline, "StakeoutMethod") || props.StakeoutMethod || object.stakeoutMethod;
      object.lineName = directText(polyline, "Name") || props.Line || props.Linje || object.lineName;
    }

    return {
      activeMapFiles,
      objects: Array.from(objects.values()).filter((object) => Object.keys(object.measured).length > 0)
    };
  }

  function splitIfcParams(text) {
    const params = [];
    let current = "";
    let depth = 0;
    let inString = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "'") {
        current += ch;
        if (inString && text[i + 1] === "'") {
          current += text[i + 1];
          i += 1;
        } else {
          inString = !inString;
        }
      } else if (!inString && ch === "(") {
        depth += 1;
        current += ch;
      } else if (!inString && ch === ")") {
        depth -= 1;
        current += ch;
      } else if (!inString && ch === "," && depth === 0) {
        params.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    params.push(current.trim());
    return params;
  }

  function parseIfcEntities(ifcText) {
    const entities = new Map();
    const text = String(ifcText || "");
    let i = 0;
    while (i < text.length) {
      if (text[i] !== "#") {
        i += 1;
        continue;
      }

      let idEnd = i + 1;
      while (idEnd < text.length && text.charCodeAt(idEnd) >= 48 && text.charCodeAt(idEnd) <= 57) idEnd += 1;
      if (idEnd === i + 1) {
        i += 1;
        continue;
      }

      let cursor = idEnd;
      while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
      if (text[cursor] !== "=") {
        i = idEnd;
        continue;
      }

      cursor += 1;
      while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
      const entityStart = cursor;
      let inString = false;
      while (cursor < text.length) {
        const ch = text[cursor];
        if (ch === "'") {
          if (inString && text[cursor + 1] === "'") {
            cursor += 2;
            continue;
          }
          inString = !inString;
        } else if (!inString && ch === ";") {
          entities.set(Number(text.slice(i + 1, idEnd)), text.slice(entityStart, cursor).trim());
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      i = cursor;
    }
    return entities;
  }

  function entityArgs(entity, name) {
    const prefix = `${name}(`;
    if (!String(entity || "").toUpperCase().startsWith(prefix)) {
      throw new Error(`Forventet ${name}, fikk ${String(entity || "").slice(0, 80)}`);
    }
    return splitIfcParams(entity.slice(prefix.length, -1));
  }

  function refs(text) {
    const out = [];
    const source = String(text || "");
    for (let i = 0; i < source.length; i += 1) {
      if (source[i] !== "#") continue;
      let cursor = i + 1;
      while (cursor < source.length && source.charCodeAt(cursor) >= 48 && source.charCodeAt(cursor) <= 57) cursor += 1;
      if (cursor > i + 1) {
        out.push(Number(source.slice(i + 1, cursor)));
        i = cursor - 1;
      }
    }
    return out;
  }

  function readEntityLineId(line) {
    const text = String(line || "");
    if (text[0] !== "#") return null;
    let cursor = 1;
    while (cursor < text.length && text.charCodeAt(cursor) >= 48 && text.charCodeAt(cursor) <= 57) cursor += 1;
    if (cursor === 1) return null;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    if (text[cursor] !== "=") return null;
    return Number(text.slice(1, String(line || "").indexOf("=")).trim());
  }

  function isCartesianPointLine(line) {
    const text = String(line || "");
    const equal = text.indexOf("=");
    if (equal < 0) return false;
    return text.slice(equal + 1).trimStart().toUpperCase().startsWith("IFCCARTESIANPOINT(");
  }

  function entityName(entity) {
    const text = String(entity || "");
    const paren = text.indexOf("(");
    return paren > 0 ? text.slice(0, paren).toUpperCase() : "";
  }

  function productArgs(entity) {
    const text = String(entity || "");
    const open = text.indexOf("(");
    if (open < 0 || !text.endsWith(")")) throw new Error(`Forventet IFC-produkt, fikk ${text.slice(0, 80)}`);
    return splitIfcParams(text.slice(open + 1, -1));
  }

  function ifcLengthScale(entity) {
    const text = String(entity || "").toUpperCase();
    if (!text.startsWith("IFCSIUNIT(") || !text.includes(".LENGTHUNIT.")) return null;
    if (text.includes(".MILLI.") && text.includes(".METRE.")) return 0.001;
    if (text.includes(".CENTI.") && text.includes(".METRE.")) return 0.01;
    if (text.includes(".DECI.") && text.includes(".METRE.")) return 0.1;
    if (text.includes(".METRE.")) return 1;
    return null;
  }

  function getIfcLengthScale(entities) {
    for (const entity of entities.values()) {
      if (!String(entity || "").toUpperCase().startsWith("IFCUNITASSIGNMENT(")) continue;
      for (const unitId of refs(entity)) {
        const scale = ifcLengthScale(entities.get(unitId));
        if (scale) return scale;
      }
    }
    for (const entity of entities.values()) {
      const scale = ifcLengthScale(entity);
      if (scale) return scale;
    }
    return 1;
  }

  function pointCoords(entity, lengthScale = 1) {
    const args = entityArgs(entity, "IFCCARTESIANPOINT");
    const nums = Array.from(args[0].matchAll(/[-+]?\d+(?:\.\d+)?(?:[Ee][-+]?\d+)?/g)).map((match) => Number(match[0]));
    if (nums.length < 3) throw new Error(`Klarte ikke lese punktkoordinat fra ${entity}`);
    return [nums[0] * lengthScale, nums[1] * lengthScale, nums[2] * lengthScale];
  }

  function directionCoords(entity, fallback) {
    if (!entity) return fallback;
    const args = entityArgs(entity, "IFCDIRECTION");
    const nums = Array.from(args[0].matchAll(/[-+]?\d+(?:\.\d+)?(?:[Ee][-+]?\d+)?/g)).map((match) => Number(match[0]));
    if (nums.length < 3) return fallback;
    return unit([nums[0], nums[1], nums[2]]);
  }

  function placementLocalToWorld(placement, point) {
    if (!placement) return point;
    return add(
      placement.worldOffset,
      add(
        add(mul(placement.xAxis, point[0]), mul(placement.yAxis, point[1])),
        mul(placement.zAxis, point[2])
      )
    );
  }

  function placementWorldToLocal(placement, point) {
    if (!placement) return point;
    const rel = sub(point, placement.worldOffset);
    return [dot(rel, placement.xAxis), dot(rel, placement.yAxis), dot(rel, placement.zAxis)];
  }

  function placementInfo(entities, placementId, lengthScale, seen = new Set()) {
    if (!placementId || seen.has(placementId)) return null;
    seen.add(placementId);
    const placement = entities.get(placementId);
    if (!placement || !entityName(placement).startsWith("IFCLOCALPLACEMENT")) return null;

    const args = entityArgs(placement, "IFCLOCALPLACEMENT");
    const parentId = refs(args[0])[0] || null;
    const axisPlacementId = refs(args[1])[0] || null;
    const axisPlacement = entities.get(axisPlacementId);
    if (!axisPlacement || !entityName(axisPlacement).startsWith("IFCAXIS2PLACEMENT3D")) return null;

    const axisArgs = entityArgs(axisPlacement, "IFCAXIS2PLACEMENT3D");
    const locationId = refs(axisArgs[0])[0] || null;
    const localOffset = pointCoords(entities.get(locationId), lengthScale);
    const zAxis = directionCoords(entities.get(refs(axisArgs[1])[0]), [0, 0, 1]);
    const xAxis = projectedAxis(directionCoords(entities.get(refs(axisArgs[2])[0]), [1, 0, 0]), zAxis);
    const yAxis = cross(zAxis, xAxis);
    const parent = placementInfo(entities, parentId, lengthScale, seen);
    const parentOffset = parent?.worldOffset || [0, 0, 0];
    return {
      placementId,
      locationId,
      localOffset,
      parentOffset,
      worldOffset: add(parentOffset, localOffset),
      xAxis,
      yAxis,
      zAxis
    };
  }

  function extractBrep(ifcText, guid) {
    const entities = parseIfcEntities(ifcText);
    const lengthScale = getIfcLengthScale(entities);
    let productId = null;
    for (const [entityId, entity] of entities.entries()) {
      if (entity.includes(`'${guid}'`) && entityName(entity).startsWith("IFC")) {
        productId = entityId;
        break;
      }
    }
    if (productId == null) throw new Error(`Fant ikke IFC-objekt med GUID ${guid}.`);

    const args = productArgs(entities.get(productId));
    const placement = placementInfo(entities, refs(args[5] || "")[0], lengthScale);
    const shapeId = refs(args[6] || "")[0];
    const shapeArgs = entityArgs(entities.get(shapeId), "IFCPRODUCTDEFINITIONSHAPE");
    const shapeRepId = refs(shapeArgs[2])[0];
    const shapeRepArgs = entityArgs(entities.get(shapeRepId), "IFCSHAPEREPRESENTATION");
    const brepId = refs(shapeRepArgs[3])[0];
    const brepArgs = entityArgs(entities.get(brepId), "IFCFACETEDBREP");
    const shellId = refs(brepArgs[0])[0];
    const shellArgs = entityArgs(entities.get(shellId), "IFCCLOSEDSHELL");
    const faceIds = refs(shellArgs[0]);

    const pointIds = new Set();
    for (const faceId of faceIds) {
      const faceArgs = entityArgs(entities.get(faceId), "IFCFACE");
      const outerBoundId = refs(faceArgs[0])[0];
      const boundArgs = entityArgs(entities.get(outerBoundId), "IFCFACEOUTERBOUND");
      const loopId = refs(boundArgs[0])[0];
      const loopArgs = entityArgs(entities.get(loopId), "IFCPOLYLOOP");
      refs(loopArgs[0]).forEach((id) => pointIds.add(id));
    }

    const points = {};
    for (const pointId of pointIds) {
      const localPoint = pointCoords(entities.get(pointId), lengthScale);
      points[pointId] = placementLocalToWorld(placement, localPoint);
    }
    if (placement?.locationId) points[placement.locationId] = placement.worldOffset;
    return {
      productId,
      points,
      geometryPointIds: Array.from(pointIds),
      placement,
      lengthScale
    };
  }

  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, scale) => [a[0] * scale, a[1] * scale, a[2] * scale];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
  const norm = (a) => Math.sqrt(dot(a, a));
  function unit(a) {
    const length = norm(a);
    if (!length) throw new Error("Null-lengde akse.");
    return mul(a, 1 / length);
  }

  function projectedAxis(seed, zAxis) {
    let projected = sub(seed, mul(zAxis, dot(seed, zAxis)));
    if (norm(projected) < 1e-9) projected = sub([0, 1, 0], mul(zAxis, dot([0, 1, 0], zAxis)));
    return unit(projected);
  }

  function transformByAxis(points, design, measured, names) {
    const bottomName = names[1];
    const topName = names[0];
    const designBottom = design[bottomName];
    const designTop = design[topName];
    const measuredBottom = measured[bottomName];
    const measuredTop = measured[topName];
    const designAxis = sub(designTop, designBottom);
    const measuredAxis = sub(measuredTop, measuredBottom);
    const designLen = norm(designAxis);
    const measuredLen = norm(measuredAxis);
    const zDesign = unit(designAxis);
    const zMeasured = unit(measuredAxis);
    const xDesign = projectedAxis([1, 0, 0], zDesign);
    const yDesign = cross(zDesign, xDesign);
    const xMeasured = projectedAxis(xDesign, zMeasured);
    const yMeasured = cross(zMeasured, xMeasured);
    const axialScale = measuredLen / designLen;
    const transformed = {};
    for (const [pointId, point] of Object.entries(points)) {
      const rel = sub(point, designBottom);
      const localX = dot(rel, xDesign);
      const localY = dot(rel, yDesign);
      const localZ = dot(rel, zDesign);
      transformed[pointId] = add(
        add(measuredBottom, mul(xMeasured, localX)),
        add(mul(yMeasured, localY), mul(zMeasured, localZ * axialScale))
      );
    }
    return { transformed, stats: { type: "axis", designLen, measuredLen, axialScale } };
  }

  function transformByQuad(points, design, measured, names) {
    const [n1, n2, n3, n4] = names;
    const d1 = design[n1], d2 = design[n2], d3 = design[n3], d4 = design[n4];
    const m1 = measured[n1], m2 = measured[n2], m3 = measured[n3], m4 = measured[n4];
    const a = sub(d2, d1);
    const b = sub(d3, d1);
    const normal = unit(cross(a, b));
    const measuredNormal = unit(cross(sub(m2, m1), sub(m3, m1)));

    function solveUv(point) {
      const rel = sub(point, d1);
      const aa = dot(a, a), ab = dot(a, b), bb = dot(b, b);
      const ar = dot(a, rel), br = dot(b, rel);
      const det = aa * bb - ab * ab;
      if (Math.abs(det) < 1e-12) throw new Error("Kontrollpunktene er degenererte.");
      const u = (ar * bb - br * ab) / det;
      const v = (br * aa - ar * ab) / det;
      const surface = add(d1, add(mul(a, u), mul(b, v)));
      return { u, v, h: dot(sub(point, surface), normal) };
    }

    function bilinear(u, v, p1, p2, p3, p4) {
      return add(
        add(mul(p1, (1 - u) * (1 - v)), mul(p2, u * (1 - v))),
        add(mul(p3, (1 - u) * v), mul(p4, u * v))
      );
    }

    const transformed = {};
    for (const [pointId, point] of Object.entries(points)) {
      const { u, v, h } = solveUv(point);
      transformed[pointId] = add(bilinear(u, v, m1, m2, m3, m4), mul(measuredNormal, h));
    }
    return { transformed, stats: { type: "quad", controlPoints: names.join(",") } };
  }

  function transformByLine(points, design, measured, names) {
    const ordered = names.filter((name) => design[name] && measured[name]);
    if (ordered.length < 2) return transformByAxis(points, design, measured, ordered);
    const d0 = design[ordered[0]];
    const dLast = design[ordered[ordered.length - 1]];
    const axis = sub(dLast, d0);
    const axisLen2 = dot(axis, axis);
    const stations = ordered.map((name) => ({
      t: axisLen2 ? dot(sub(design[name], d0), axis) / axisLen2 : 0,
      delta: sub(measured[name], design[name])
    })).sort((a, b) => a.t - b.t);

    function deltaAt(t) {
      if (t <= stations[0].t) return stations[0].delta;
      if (t >= stations[stations.length - 1].t) return stations[stations.length - 1].delta;
      for (let i = 0; i < stations.length - 1; i += 1) {
        const a = stations[i];
        const b = stations[i + 1];
        if (t >= a.t && t <= b.t) {
          const f = (t - a.t) / (b.t - a.t || 1);
          return add(mul(a.delta, 1 - f), mul(b.delta, f));
        }
      }
      return stations[0].delta;
    }

    const transformed = {};
    for (const [pointId, point] of Object.entries(points)) {
      const t = axisLen2 ? dot(sub(point, d0), axis) / axisLen2 : 0;
      transformed[pointId] = add(point, deltaAt(t));
    }
    return { transformed, stats: { type: "line", controlPoints: ordered.join(",") } };
  }

  function selectTransform(object, brep) {
    const names = object.pointOrder.filter((name) => object.design[name] && object.measured[name]);
    if (/ToTheLine/i.test(object.stakeoutMethod || object.props.StakeoutMethod || "")) {
      return transformByLine(brep.points, object.design, object.measured, names);
    }
    if (names.length >= 4) return transformByQuad(brep.points, object.design, object.measured, names.slice(0, 4));
    if (names.length >= 2) return transformByAxis(brep.points, object.design, object.measured, names.slice(0, 2));
    throw new Error(`GUID ${object.guid} har for få kontrollpunkter.`);
  }

  function ifcNum(value) {
    return Number(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "") || "0";
  }

  function replaceCartesianPoints(ifcText, transformedPoints, lengthScale = 1) {
    return String(ifcText || "").split(/\r?\n/).map((line) => {
      if (!isCartesianPointLine(line)) return line;
      const id = readEntityLineId(line);
      const point = transformedPoints[id];
      if (!point) return line;
      const fileCoords = point.map((coord) => coord / lengthScale);
      return `#${id}= IFCCARTESIANPOINT((${ifcNum(fileCoords[0])},${ifcNum(fileCoords[1])},${ifcNum(fileCoords[2])}));`;
    }).join("\n");
  }

  function guidFromSeed(seed) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < seed.length; i += 1) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    let value = BigInt(hash);
    for (let i = 0; i < seed.length; i += 1) value = (value * 131n + BigInt(seed.charCodeAt(i))) & ((1n << 132n) - 1n);
    let out = "";
    for (let i = 0; i < 22; i += 1) {
      out += IFC_GUID_CHARS[Number(value & 63n)];
      value >>= 6n;
    }
    return out;
  }

  function ifcString(value) {
    return `'${String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  }

  function setProductMmi(ifcText, productGuid, value = "500") {
    const entities = parseIfcEntities(ifcText);
    let productId = null;
    let nextId = 1;
    for (const [entityId, entity] of entities.entries()) {
      if (entityId >= nextId) nextId = entityId + 1;
      if (entity.includes(`'${productGuid}'`)) {
        productId = entityId;
      }
    }
    if (productId == null) return ifcText;

    const additions = [];
    const replacements = new Map();

    for (const [relId, rel] of entities.entries()) {
      if (!rel.toUpperCase().startsWith("IFCRELDEFINESBYPROPERTIES(")) continue;
      const relArgs = entityArgs(rel, "IFCRELDEFINESBYPROPERTIES");
      const related = refs(relArgs[4]);
      if (!related.includes(productId)) continue;
      const psetId = refs(relArgs[5])[0];
      const pset = entities.get(psetId);
      if (!pset || !pset.toUpperCase().startsWith("IFCPROPERTYSET(")) continue;
      const psetArgs = entityArgs(pset, "IFCPROPERTYSET");
      const propRefs = refs(psetArgs[4]);
      const mmiIndex = propRefs.findIndex((propRef) => {
        const prop = entities.get(propRef) || "";
        if (!prop.toUpperCase().startsWith("IFCPROPERTYSINGLEVALUE(")) return false;
        return entityArgs(prop, "IFCPROPERTYSINGLEVALUE")[0].replace(/^'|'$/g, "") === "A22 MMI";
      });
      if (mmiIndex < 0) continue;

      if (related.length > 1) {
        relArgs[4] = `(${related.filter((id) => id !== productId).map((id) => `#${id}`).join(",")})`;
        replacements.set(relId, `IFCRELDEFINESBYPROPERTIES(${relArgs.join(",")})`);
      }

      const mmiPropId = nextId++;
      additions.push(`#${mmiPropId}= IFCPROPERTYSINGLEVALUE('A22 MMI',$,IFCTEXT('${value}'),$);`);
      const newPropRefs = [...propRefs];
      newPropRefs[mmiIndex] = mmiPropId;
      const newPsetId = nextId++;
      psetArgs[0] = ifcString(guidFromSeed(`mmi-pset-${productGuid}-${newPsetId}`));
      psetArgs[4] = `(${newPropRefs.map((id) => `#${id}`).join(",")})`;
      additions.push(`#${newPsetId}= IFCPROPERTYSET(${psetArgs.join(",")});`);
      const newRelId = nextId++;
      additions.push(`#${newRelId}= IFCRELDEFINESBYPROPERTIES(${ifcString(guidFromSeed(`mmi-rel-${productGuid}-${newRelId}`))},${relArgs[1]},$,$,(#${productId}),#${newPsetId});`);
      break;
    }

    if (!additions.length) return ifcText;
    const replaced = String(ifcText || "").split(/\r?\n/).map((line) => {
      const id = readEntityLineId(line);
      if (id == null) return line;
      const replacement = replacements.get(id);
      return replacement ? `#${id}= ${replacement};` : line;
    }).join("\n");
    const footer = "ENDSEC;\nEND-ISO-10303-21;";
    const footerIndex = replaced.lastIndexOf("ENDSEC;");
    if (footerIndex < 0) return `${replaced}\n${additions.join("\n")}\n`;
    return `${replaced.slice(0, footerIndex)}${additions.join("\n")}\n${footer}`;
  }

  function asBuiltName(originalName) {
    return String(originalName || "model.ifc")
      .replace(/(?:\s+AS\s+BUILT)+\.ifc$/i, ".ifc")
      .replace(/\.ifc$/i, " AS BUILT.ifc");
  }

  function buildAsBuiltIfc({ jxlText, ifcText, ifcName }) {
    const parsed = parseJxl(jxlText);
    const targetName = String(ifcName || "");
    const objects = parsed.objects.filter((object) => {
      if (!object.activeMapFiles.length || !targetName) return true;
      return object.activeMapFiles.some((name) => name.toLowerCase().endsWith(targetName.toLowerCase()));
    });

    let output = String(ifcText || "");
    const transformedGuids = [];
    const errors = [];
    const stats = [];

    for (const object of objects) {
      try {
        const brep = extractBrep(output, object.guid);
        const transform = selectTransform(object, brep);
        const transformed = { ...transform.transformed };
        if (brep.placement?.locationId && transformed[brep.placement.locationId]) {
          const transformedPlacementWorld = transformed[brep.placement.locationId];
          transformed[brep.placement.locationId] = sub(transformedPlacementWorld, brep.placement.parentOffset);
          for (const pointId of brep.geometryPointIds || []) {
            if (transformed[pointId]) {
              transformed[pointId] = placementWorldToLocal(
                { ...brep.placement, worldOffset: transformedPlacementWorld },
                transformed[pointId]
              );
            }
          }
        }
        output = replaceCartesianPoints(output, transformed, brep.lengthScale);
        const objectStats = {
          guid: object.guid,
          lengthScale: brep.lengthScale,
          placement: brep.placement ? "local" : "none",
          ...transform.stats
        };
        try {
          output = setProductMmi(output, object.guid, "500");
        } catch (err) {
          objectStats.mmiWarning = err?.message || String(err);
        }
        transformedGuids.push(object.guid);
        stats.push(objectStats);
      } catch (err) {
        errors.push({ guid: object.guid, error: err?.message || String(err) });
      }
    }

    output = output.replace(/FILE_NAME\('([^']*)'/, `FILE_NAME('${asBuiltName(ifcName)}'`);

    return {
      ok: transformedGuids.length > 0,
      text: output,
      outName: asBuiltName(ifcName),
      activeMapFiles: parsed.activeMapFiles,
      transformedGuids,
      errors,
      stats
    };
  }

  window.AsBuiltEngine = {
    parseJxl,
    buildAsBuiltIfc,
    asBuiltName
  };
})();
