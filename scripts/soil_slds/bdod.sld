<StyledLayerDescriptor xmlns="http://www.opengis.net/sld" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ogc="http://www.opengis.net/ogc" xmlns:gml="http://www.opengis.net/gml" xsi:schemaLocation="http://www.opengis.net/sld StyledLayerDescriptor.xsd" version="1.0.0">
  <NamedLayer>
    <Name>bdod</Name>
    <UserStyle>
      <Title>bdod</Title>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
           <Geometry>
              <PropertyName>Bulk density (cg/cm³)</PropertyName>
              <Opacity>1</Opacity>
            </Geometry>
            <ColorMap type="intervals">
              <ColorMapEntry  quantity="-32768"  label="NODATA" color="#FFFFFF" opacity="0.7"/>
          	  <ColorMapEntry quantity="0" color="#f0f9e8" label="0"/>
			  <ColorMapEntry quantity="10" color="#f0f9e8" label="10"/>
              <ColorMapEntry quantity="53" color="#e9f7e3" label="53"/>
              <ColorMapEntry quantity="62" color="#e2f4dd" label="62"/>
              <ColorMapEntry quantity="68" color="#dbf1d7" label="68"/>
              <ColorMapEntry quantity="74" color="#d4efd2" label="74"/>
              <ColorMapEntry quantity="80" color="#cdeccc" label="80"/>
              <ColorMapEntry quantity="86" color="#c6e9c6" label="86"/>
              <ColorMapEntry quantity="93" color="#bfe6c1" label="93"/>
              <ColorMapEntry quantity="98" color="#b8e4bc" label="98"/>
              <ColorMapEntry quantity="104" color="#b0e1be" label="104"/>
              <ColorMapEntry quantity="109" color="#a8ddbf" label="109"/>
              <ColorMapEntry quantity="113" color="#a0dac0" label="113"/>
              <ColorMapEntry quantity="117" color="#98d7c1" label="117"/>
              <ColorMapEntry quantity="120" color="#8fd4c2" label="120"/>
              <ColorMapEntry quantity="123" color="#87d1c3" label="123"/>
              <ColorMapEntry quantity="125" color="#7fcec4" label="125"/>
              <ColorMapEntry quantity="127" color="#77cac5" label="127"/>
              <ColorMapEntry quantity="129" color="#70c4c5" label="129"/>
              <ColorMapEntry quantity="131" color="#69bfc6" label="131"/>
              <ColorMapEntry quantity="133" color="#62b9c7" label="133"/>
              <ColorMapEntry quantity="134" color="#5ab4c8" label="134"/>
              <ColorMapEntry quantity="136" color="#53aec9" label="136"/>
              <ColorMapEntry quantity="137" color="#4ca9c9" label="137"/>
              <ColorMapEntry quantity="139" color="#45a3ca" label="139"/>
              <ColorMapEntry quantity="140" color="#3d9cc7" label="140"/>
              <ColorMapEntry quantity="142" color="#3595c3" label="142"/>
              <ColorMapEntry quantity="144" color="#2e8dc0" label="144"/>
              <ColorMapEntry quantity="145" color="#2686bc" label="145"/>
              <ColorMapEntry quantity="147" color="#1e7eb8" label="147"/>
              <ColorMapEntry quantity="149" color="#1777b4" label="149"/>
              <ColorMapEntry quantity="152" color="#0f6fb0" label="152"/>
              <ColorMapEntry quantity="174" color="#0868ac" label="174"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
            