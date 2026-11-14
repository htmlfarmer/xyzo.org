<StyledLayerDescriptor xmlns="http://www.opengis.net/sld" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ogc="http://www.opengis.net/ogc" xmlns:gml="http://www.opengis.net/gml" xsi:schemaLocation="http://www.opengis.net/sld StyledLayerDescriptor.xsd" version="1.0.0">
  <NamedLayer>
    <Name>soc</Name>
    <UserStyle>
      <Title>soc</Title>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
           <Geometry>
              <PropertyName>Soil organic carbon (dg/kg)</PropertyName>
              <Opacity>1</Opacity>
            </Geometry>
            <ColorMap type="intervals">
              <ColorMapEntry color="#FFFFFF" quantity="-32768" label="NODATA" opacity="0.7"/>
               <ColorMapEntry quantity="0" color="#ffffff" label="0"/>
			  <ColorMapEntry quantity="6" color="#ffffff" label="6"/>
              <ColorMapEntry quantity="27" color="#fbf9f9" label="27"/>
              <ColorMapEntry quantity="38" color="#f6f3f2" label="38"/>
              <ColorMapEntry quantity="43" color="#f2edec" label="43"/>
              <ColorMapEntry quantity="53" color="#ede7e5" label="53"/>
              <ColorMapEntry quantity="64" color="#e9e1de" label="64"/>
              <ColorMapEntry quantity="85" color="#e4dad8" label="85"/>
              <ColorMapEntry quantity="106" color="#dfd4d1" label="106"/>
              <ColorMapEntry quantity="127" color="#dbceca" label="127"/>
              <ColorMapEntry quantity="142" color="#d6c8c4" label="142"/>
              <ColorMapEntry quantity="163" color="#d2c2bd" label="163"/>
              <ColorMapEntry quantity="184" color="#cdbbb7" label="184"/>
              <ColorMapEntry quantity="210" color="#c9b5b0" label="210"/>
              <ColorMapEntry quantity="236" color="#c4afa9" label="236"/>
              <ColorMapEntry quantity="268" color="#bfa9a3" label="268"/>
              <ColorMapEntry quantity="299" color="#bba39c" label="299"/>
              <ColorMapEntry quantity="330" color="#b69d95" label="330"/>
              <ColorMapEntry quantity="362" color="#b2968f" label="362"/>
              <ColorMapEntry quantity="398" color="#ad9088" label="398"/>
              <ColorMapEntry quantity="445" color="#a98a82" label="445"/>
              <ColorMapEntry quantity="492" color="#a4847b" label="492"/>
              <ColorMapEntry quantity="560" color="#9f7e74" label="560"/>
              <ColorMapEntry quantity="633" color="#9b786e" label="633"/>
              <ColorMapEntry quantity="727" color="#967167" label="727"/>
              <ColorMapEntry quantity="832" color="#926b60" label="832"/>
              <ColorMapEntry quantity="962" color="#8d655a" label="962"/>
              <ColorMapEntry quantity="1114" color="#895f53" label="1114"/>
              <ColorMapEntry quantity="1312" color="#84594d" label="1312"/>
              <ColorMapEntry quantity="1521" color="#7f5246" label="1521"/>
              <ColorMapEntry quantity="1839" color="#7b4c3f" label="1839"/>
              <ColorMapEntry quantity="2174" color="#764639" label="2174"/>
              <ColorMapEntry quantity="4471" color="#724032" label="4471"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
