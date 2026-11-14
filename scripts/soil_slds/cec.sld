<StyledLayerDescriptor xmlns="http://www.opengis.net/sld" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ogc="http://www.opengis.net/ogc" xmlns:gml="http://www.opengis.net/gml" xsi:schemaLocation="http://www.opengis.net/sld StyledLayerDescriptor.xsd" version="1.0.0">
  <NamedLayer>
    <Name>cec</Name>
    <UserStyle>
      <Title>cec</Title>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
           <Geometry>
              <PropertyName>CEC ph7 (mmol(c)/kg)</PropertyName>
              <Opacity>1</Opacity>
            </Geometry>
             <ColorMap type="intervals">
              <ColorMapEntry color="#FFFFFF" quantity="-32768" label="NODATA" opacity="0.7"/>
              <ColorMapEntry quantity="0" color="#edf8fb" label="0"/>
			<ColorMapEntry quantity="11" color="#edf8fb" label="11"/>
              <ColorMapEntry quantity="95" color="#e6f3f8" label="95"/>
              <ColorMapEntry quantity="111" color="#deedf5" label="111"/>
              <ColorMapEntry quantity="122" color="#d7e8f2" label="122"/>
              <ColorMapEntry quantity="130" color="#cfe2ef" label="130"/>
              <ColorMapEntry quantity="137" color="#c8ddec" label="137"/>
              <ColorMapEntry quantity="145" color="#c0d7e9" label="145"/>
              <ColorMapEntry quantity="153" color="#b9d1e6" label="153"/>
              <ColorMapEntry quantity="161" color="#b2cce2" label="161"/>
              <ColorMapEntry quantity="170" color="#adc4df" label="170"/>
              <ColorMapEntry quantity="179" color="#a8bddb" label="179"/>
              <ColorMapEntry quantity="189" color="#a3b6d7" label="189"/>
              <ColorMapEntry quantity="199" color="#9eafd3" label="199"/>
              <ColorMapEntry quantity="209" color="#99a8d0" label="209"/>
              <ColorMapEntry quantity="219" color="#94a1cc" label="219"/>
              <ColorMapEntry quantity="229" color="#8f9ac8" label="229"/>
              <ColorMapEntry quantity="239" color="#8c92c4" label="239"/>
              <ColorMapEntry quantity="249" color="#8b8ac0" label="249"/>
              <ColorMapEntry quantity="258" color="#8b81bc" label="258"/>
              <ColorMapEntry quantity="270" color="#8a79b8" label="270"/>
              <ColorMapEntry quantity="282" color="#8a71b4" label="282"/>
              <ColorMapEntry quantity="296" color="#8968b0" label="296"/>
              <ColorMapEntry quantity="313" color="#8960ac" label="313"/>
              <ColorMapEntry quantity="337" color="#8858a8" label="337"/>
              <ColorMapEntry quantity="359" color="#8e50aa" label="359"/>
              <ColorMapEntry quantity="380" color="#9748ad" label="380"/>
              <ColorMapEntry quantity="404" color="#9f40b1" label="404"/>
              <ColorMapEntry quantity="431" color="#a837b4" label="431"/>
              <ColorMapEntry quantity="465" color="#b02fb7" label="465"/>
              <ColorMapEntry quantity="505" color="#b927bb" label="505"/>
              <ColorMapEntry quantity="570" color="#c11fbe" label="570"/>
              <ColorMapEntry quantity="852" color="#ca17c2" label="852"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
